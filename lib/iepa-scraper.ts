/**
 * IEPA Document Explorer Scraper v6
 * Better DocuWare table row detection
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright';

export interface FacilityResult {
  id: string;
  name: string;
  address: string;
  city: string;
  county: string;
  zip: string;
  programs: string[];
  link: string;
}

export interface DocumentInfo {
  id: string;
  type: string;
  date: string;
  category: string;
  description: string;
  viewerUrl?: string;
  rowIndex?: number;
}

export interface DownloadedDocument extends DocumentInfo {
  pdfBuffer: Buffer;
  filename: string;
}

export class IEPAScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isInitialized = false;
  private docuwareUrl: string = '';

  async init(): Promise<void> {
    if (this.isInitialized) return;
    console.log('Initializing browser...');
    
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
    });

    this.page = await this.context.newPage();
    this.isInitialized = true;
  }

  async searchFacilities(query: string): Promise<FacilityResult[]> {
    if (!this.page) throw new Error('Not initialized');
    console.log(`Searching: "${query}"`);

    await this.page.goto('https://webapps.illinois.gov/EPA/DocumentExplorer/Attributes', {
      waitUntil: 'networkidle', timeout: 60000,
    });
    await this.page.waitForTimeout(3000);

    const nameField = await this.page.$('#Name, input[name="Name"]');
    if (nameField) await nameField.fill(query.trim());
    
    await this.page.click('button[type="submit"], .btn-primary');
    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(3000);

    const facilities = await this.page.evaluate(() => {
      const results: any[] = [];
      document.querySelectorAll('table tbody tr').forEach((row, i) => {
        const link = row.querySelector('a[href*="Documents"]');
        if (link) {
          const href = link.getAttribute('href') || '';
          const cells = row.querySelectorAll('td');
          results.push({
            id: href.match(/\/(\d+)/)?.[1] || `f-${i}`,
            name: cells[0]?.textContent?.trim() || '',
            address: cells[1]?.textContent?.trim() || '',
            city: cells[2]?.textContent?.trim() || '',
            county: cells[3]?.textContent?.trim() || '',
            zip: cells[4]?.textContent?.trim() || '',
            programs: [],
            link: href.startsWith('http') ? href : `https://webapps.illinois.gov${href}`,
          });
        }
      });
      return results;
    });

    console.log(`Found ${facilities.length} facilities`);
    return facilities;
  }

  async getFacilityDocuments(facilityId: string): Promise<DocumentInfo[]> {
    if (!this.page) throw new Error('Not initialized');

    const url = facilityId.startsWith('http') ? facilityId 
      : `https://webapps.illinois.gov/EPA/DocumentExplorer/Documents/Index/${facilityId}`;
    
    console.log(`Loading facility page: ${url}`);
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(3000);

    // Find DocuWare link
    const docuwareHref = await this.page.evaluate(() => {
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.toLowerCase().includes('docuware')) {
          return href;
        }
      }
      return null;
    });

    if (!docuwareHref) {
      console.log('No DocuWare link found');
      return [];
    }

    this.docuwareUrl = docuwareHref.startsWith('http') ? docuwareHref : `https://webapps.illinois.gov${docuwareHref}`;
    console.log(`Opening DocuWare: ${this.docuwareUrl}`);

    // Open DocuWare
    await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
    
    // Wait longer for DocuWare to fully load its dynamic content
    console.log('Waiting for DocuWare to load...');
    await this.page.waitForTimeout(8000);

    // Try to wait for table rows to appear
    try {
      await this.page.waitForSelector('tr, [class*="Row"], [class*="row"]', { timeout: 10000 });
      console.log('Found row elements');
    } catch (e) {
      console.log('No row elements found after waiting');
    }

    // Debug: Log page content structure
    const pageInfo = await this.page.evaluate(() => {
      const info: any = {
        title: document.title,
        bodyClasses: document.body.className,
        tables: document.querySelectorAll('table').length,
        trs: document.querySelectorAll('tr').length,
        divs: document.querySelectorAll('div').length,
      };
      
      // Find any element that might contain document data
      const possibleContainers = document.querySelectorAll('[class*="result"], [class*="Result"], [class*="list"], [class*="List"], [class*="grid"], [class*="Grid"], table');
      info.containers = Array.from(possibleContainers).map(c => ({
        tag: c.tagName,
        class: c.className?.substring?.(0, 100),
        children: c.children.length
      }));

      // Get all text content that looks like dates (document indicators)
      const allText = document.body.innerText;
      const dateMatches = allText.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
      info.datesFound = dateMatches.slice(0, 10);

      return info;
    });

    console.log('Page info:', JSON.stringify(pageInfo, null, 2));

    // Get documents using multiple selector strategies
    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      
      // Strategy 1: Standard table rows
      let rows = document.querySelectorAll('table tbody tr');
      console.log(`Strategy 1 (table tbody tr): ${rows.length} rows`);
      
      // Strategy 2: Any tr elements
      if (rows.length === 0) {
        rows = document.querySelectorAll('tr');
        console.log(`Strategy 2 (tr): ${rows.length} rows`);
      }
      
      // Strategy 3: Div-based rows (some grids use divs)
      if (rows.length <= 1) {
        rows = document.querySelectorAll('[class*="Row"]:not([class*="Header"]), [class*="row"]:not([class*="header"]), [role="row"]');
        console.log(`Strategy 3 (div rows): ${rows.length} rows`);
      }

      // Strategy 4: Look for elements containing dates
      if (rows.length <= 1) {
        const allElements = document.querySelectorAll('*');
        const rowLike: Element[] = [];
        allElements.forEach(el => {
          const text = el.textContent || '';
          if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(text) && el.children.length >= 2) {
            // Check if this is a "row-like" element (has multiple columns/cells)
            const childCount = el.children.length;
            if (childCount >= 3 && childCount <= 15) {
              rowLike.push(el);
            }
          }
        });
        if (rowLike.length > 0) {
          rows = rowLike as any;
          console.log(`Strategy 4 (date containers): ${rows.length} rows`);
        }
      }

      rows.forEach((row, idx) => {
        // Skip header rows
        if (row.querySelector('th') || row.className?.toLowerCase().includes('header')) {
          return;
        }

        const cells = row.querySelectorAll('td, [class*="Cell"], [class*="cell"], > div, > span');
        if (cells.length >= 2) {
          const texts = Array.from(cells).map(c => c.textContent?.trim() || '');
          
          // Find date
          let date = '';
          for (const text of texts) {
            const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
            if (dateMatch) {
              date = dateMatch[0];
              break;
            }
          }

          // Only add if we found meaningful data
          if (date || texts.some(t => t.length > 3)) {
            docs.push({
              id: `dw-${idx}`,
              type: texts[0] || 'Document',
              date: date || 'Unknown',
              category: 'LUST Technical',
              description: texts.slice(1, 4).filter(t => t).join(' | '),
              rowIndex: idx,
            });
          }
        }
      });
      
      return docs;
    });

    console.log(`Found ${documents.length} documents in DocuWare`);
    
    // If still no documents, try one more approach - look for clickable document icons
    if (documents.length === 0) {
      console.log('Trying icon-based detection...');
      const iconDocs = await this.page.evaluate(() => {
        const docs: any[] = [];
        // DocuWare often uses icons that are clickable
        const icons = document.querySelectorAll('[class*="icon"], [class*="Icon"], img[src*="doc"], img[src*="pdf"]');
        icons.forEach((icon, idx) => {
          const parent = icon.closest('tr, [class*="Row"], [class*="row"]');
          if (parent) {
            const text = parent.textContent || '';
            const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
            if (dateMatch) {
              docs.push({
                id: `icon-${idx}`,
                type: 'Document',
                date: dateMatch[0],
                category: 'LUST Technical',
                description: text.substring(0, 100),
                rowIndex: idx,
              });
            }
          }
        });
        return docs;
      });
      
      if (iconDocs.length > 0) {
        console.log(`Found ${iconDocs.length} documents via icons`);
        return iconDocs;
      }
    }

    return documents;
  }

  async downloadDocument(doc: DocumentInfo): Promise<DownloadedDocument | null> {
    if (!this.page || !this.context) throw new Error('Not initialized');

    const rowIdx = doc.rowIndex ?? 0;
    console.log(`\n=== Downloading row ${rowIdx}: ${doc.date} ===`);

    try {
      // Make sure we're on DocuWare
      if (!this.page.url().toLowerCase().includes('docuware') && this.docuwareUrl) {
        await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await this.page.waitForTimeout(8000);
      }

      // Find all clickable rows
      const rows = await this.page.$$('tr, [class*="Row"]:not([class*="Header"]), [role="row"]');
      console.log(`Found ${rows.length} rows`);
      
      if (rowIdx >= rows.length) {
        console.log(`Row ${rowIdx} out of range`);
        return null;
      }

      // Click to select
      console.log('Clicking row...');
      await rows[rowIdx].click();
      await this.page.waitForTimeout(2000);

      // Try double-click to open viewer
      console.log('Double-clicking to open viewer...');
      await rows[rowIdx].dblclick();
      await this.page.waitForTimeout(5000);

      // Check for new pages
      const pages = this.context.pages();
      let viewerPage = pages[pages.length - 1];
      
      if (viewerPage !== this.page) {
        console.log(`Viewer opened: ${viewerPage.url()}`);
        await viewerPage.waitForTimeout(3000);
      }

      // Look for PDF iframe or object
      const pdfSrc = await viewerPage.evaluate(() => {
        // Check iframes
        const iframe = document.querySelector('iframe');
        if (iframe?.src) return iframe.src;
        
        // Check objects
        const obj = document.querySelector('object');
        if (obj?.data) return obj.data;
        
        // Check embeds
        const embed = document.querySelector('embed');
        if (embed?.src) return embed.src;

        // Check for any PDF links
        const links = document.querySelectorAll('a[href*=".pdf"], a[href*="GetDocument"], a[href*="Download"]');
        for (const link of links) {
          const href = link.getAttribute('href');
          if (href) return href;
        }

        return null;
      });

      if (pdfSrc) {
        console.log(`Found PDF source: ${pdfSrc}`);
        try {
          const fullUrl = pdfSrc.startsWith('http') ? pdfSrc : new URL(pdfSrc, viewerPage.url()).href;
          const response = await viewerPage.request.get(fullUrl);
          const buffer = await response.body();
          
          if (buffer.length > 500 && buffer[0] === 0x25) {
            console.log(`SUCCESS! Got ${buffer.length} bytes`);
            if (viewerPage !== this.page) await viewerPage.close();
            return {
              ...doc,
              pdfBuffer: buffer,
              filename: `document_${doc.date.replace(/\//g, '-')}.pdf`,
            };
          }
        } catch (e) {
          console.log('PDF fetch error:', e);
        }
      }

      // Try download button
      const downloadBtn = await viewerPage.$('[title*="ownload" i], [class*="download" i], button:has-text("Download")');
      if (downloadBtn) {
        console.log('Clicking download button...');
        try {
          const [download] = await Promise.all([
            viewerPage.waitForEvent('download', { timeout: 15000 }),
            downloadBtn.click(),
          ]);
          
          if (download) {
            const path = await download.path();
            if (path) {
              const fs = require('fs');
              const buffer = fs.readFileSync(path);
              console.log(`SUCCESS! Downloaded ${buffer.length} bytes`);
              if (viewerPage !== this.page) await viewerPage.close();
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
              };
            }
          }
        } catch (e) {
          console.log('Download button failed');
        }
      }

      if (viewerPage !== this.page) await viewerPage.close();
      await this.page.keyboard.press('Escape');
      
      console.log('Download failed');
      return null;

    } catch (error) {
      console.error(`Error: ${error}`);
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isInitialized = false;
    }
  }
}

let scraperInstance: IEPAScraper | null = null;

export async function getScraper(): Promise<IEPAScraper> {
  if (!scraperInstance) {
    scraperInstance = new IEPAScraper();
    await scraperInstance.init();
  }
  return scraperInstance;
}

export async function closeScraper(): Promise<void> {
  if (scraperInstance) {
    await scraperInstance.close();
    scraperInstance = null;
  }
}
