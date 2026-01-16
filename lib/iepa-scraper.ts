/**
 * IEPA Document Explorer Scraper v5
 * Fixed DocuWare link detection
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
      waitUntil: 'networkidle',
      timeout: 60000,
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

    // Find DocuWare links - they can be in different places
    // Look for links that contain "docuware" in href OR links in the "Imaged Documents" section
    const docuwareHref = await this.page.evaluate(() => {
      // Method 1: Direct docuware links
      const directLink = document.querySelector('a[href*="docuware" i]');
      if (directLink) return directLink.getAttribute('href');

      // Method 2: Links in Imaged Documents section (like "Leaking UST Technical")
      const imagedSection = document.querySelector('h3:contains("Imaged"), h4:contains("Imaged"), *:contains("Imaged Documents")');
      if (imagedSection) {
        const parent = imagedSection.closest('div, section, table');
        if (parent) {
          const link = parent.querySelector('a[href*="docuware" i]');
          if (link) return link.getAttribute('href');
        }
      }

      // Method 3: Any link that looks like it goes to DocuWare
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        if (href.toLowerCase().includes('docuware')) {
          return href;
        }
      }

      // Method 4: Links with text containing "Technical", "UST", "LUST", etc.
      for (const link of allLinks) {
        const text = link.textContent?.toLowerCase() || '';
        const href = link.getAttribute('href') || '';
        if ((text.includes('technical') || text.includes('ust') || text.includes('lust') || 
             text.includes('remediation') || text.includes('leaking')) && 
            href.includes('docuware')) {
          return href;
        }
      }

      return null;
    });

    if (!docuwareHref) {
      console.log('No DocuWare link found on page');
      
      // Debug: print all links on page
      const allLinks = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('a')).map(a => ({
          text: a.textContent?.trim().substring(0, 50),
          href: a.getAttribute('href')?.substring(0, 100)
        }));
      });
      console.log('Links found on page:', JSON.stringify(allLinks.slice(0, 20), null, 2));
      
      return [];
    }

    this.docuwareUrl = docuwareHref.startsWith('http') ? docuwareHref : `https://webapps.illinois.gov${docuwareHref}`;
    console.log(`Opening DocuWare: ${this.docuwareUrl}`);

    // Open DocuWare
    await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(5000);

    console.log(`DocuWare page loaded: ${this.page.url()}`);

    // Get document list from DocuWare
    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      
      // DocuWare uses various table/grid structures
      const rows = document.querySelectorAll(
        'table tbody tr, ' +
        '[class*="ResultList"] tr, ' +
        '[class*="result"] tr, ' +
        '[class*="Row"]:not([class*="Header"]), ' +
        '[role="row"]'
      );
      
      console.log(`Found ${rows.length} rows in DocuWare`);
      
      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td, [class*="Cell"], [role="cell"]');
        if (cells.length >= 2) {
          const texts = Array.from(cells).map(c => c.textContent?.trim() || '');
          
          // Find date pattern
          let date = '';
          for (const text of texts) {
            const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
            if (dateMatch) {
              date = dateMatch[0];
              break;
            }
          }
          
          // Get document type from first column (usually has an icon)
          const typeCell = cells[0];
          let type = typeCell?.textContent?.trim() || 'Document';
          if (type.length < 2) type = 'Document'; // If it's just an icon
          
          // Get site name (usually column 2 or 3)
          const siteName = texts[2] || texts[1] || '';
          
          docs.push({
            id: `dw-${idx}`,
            type: type,
            date: date || texts.find(t => t.includes('/')) || 'Unknown',
            category: 'LUST Technical',
            description: siteName,
            rowIndex: idx,
          });
        }
      });
      
      return docs;
    });

    console.log(`Found ${documents.length} documents in DocuWare`);
    return documents;
  }

  async downloadDocument(doc: DocumentInfo): Promise<DownloadedDocument | null> {
    if (!this.page || !this.context) throw new Error('Not initialized');

    const rowIdx = doc.rowIndex ?? 0;
    console.log(`\n=== Downloading row ${rowIdx}: ${doc.type} (${doc.date}) ===`);

    try {
      // Make sure we're on DocuWare
      const currentUrl = this.page.url();
      if (!currentUrl.toLowerCase().includes('docuware') && this.docuwareUrl) {
        console.log('Navigating back to DocuWare...');
        await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await this.page.waitForTimeout(5000);
      }

      // Get all rows
      const rows = await this.page.$$('table tbody tr, [class*="Row"]:not([class*="Header"]), [role="row"]');
      console.log(`Found ${rows.length} rows on page`);
      
      if (rowIdx >= rows.length) {
        console.log(`Row ${rowIdx} not found (only ${rows.length} rows)`);
        return null;
      }

      const targetRow = rows[rowIdx];

      // Step 1: Click row to select it
      console.log('Step 1: Clicking row to select...');
      await targetRow.click();
      await this.page.waitForTimeout(2000);

      // Step 2: Try toolbar download button
      console.log('Step 2: Looking for toolbar download button...');
      const downloadBtn = await this.page.$('[title*="ownload" i], [class*="download" i], [aria-label*="ownload" i]');
      
      if (downloadBtn) {
        console.log('Found download button, clicking...');
        try {
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 15000 }),
            downloadBtn.click(),
          ]);

          if (download) {
            console.log(`Download started: ${download.suggestedFilename()}`);
            const path = await download.path();
            if (path) {
              const fs = require('fs');
              const buffer = fs.readFileSync(path);
              console.log(`SUCCESS! Downloaded ${buffer.length} bytes`);
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename() || `${doc.type}.pdf`,
              };
            }
          }
        } catch (e) {
          console.log('Toolbar download timed out');
        }
      }

      // Step 3: Double-click to open document viewer
      console.log('Step 3: Double-clicking to open viewer...');
      await targetRow.dblclick();
      await this.page.waitForTimeout(5000);

      // Check for new tab/popup
      const pages = this.context.pages();
      console.log(`Total pages open: ${pages.length}`);
      
      let viewerPage = this.page;
      if (pages.length > 1) {
        viewerPage = pages[pages.length - 1];
        console.log(`Viewer opened in new tab: ${viewerPage.url()}`);
        await viewerPage.waitForTimeout(3000);
      }

      // Step 4: Look for PDF in viewer
      console.log('Step 4: Looking for PDF in viewer...');
      
      // Check for iframe
      const iframe = await viewerPage.$('iframe');
      if (iframe) {
        const src = await iframe.getAttribute('src');
        console.log(`Found iframe with src: ${src}`);
        
        if (src && (src.includes('pdf') || src.includes('GetDocument') || src.includes('Viewer'))) {
          try {
            const fullUrl = src.startsWith('http') ? src : new URL(src, viewerPage.url()).href;
            console.log(`Fetching: ${fullUrl}`);
            const response = await viewerPage.request.get(fullUrl);
            const buffer = await response.body();
            
            console.log(`Got ${buffer.length} bytes, first byte: ${buffer[0]}`);
            
            if (buffer.length > 500 && buffer[0] === 0x25) { // %PDF
              console.log('SUCCESS! Got PDF from iframe');
              if (viewerPage !== this.page) await viewerPage.close();
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: `${doc.type.replace(/[^a-z0-9]/gi, '_')}_${doc.date.replace(/\//g, '-')}.pdf`,
              };
            }
          } catch (e) {
            console.log('Iframe fetch error:', e);
          }
        }
      }

      // Step 5: Look for download button in viewer
      console.log('Step 5: Looking for download button in viewer...');
      const viewerDownloadBtn = await viewerPage.$('[title*="ownload" i], [class*="download" i], button:has-text("Download"), a:has-text("Download")');
      if (viewerDownloadBtn) {
        console.log('Found viewer download button');
        try {
          const [download] = await Promise.all([
            viewerPage.waitForEvent('download', { timeout: 15000 }),
            viewerDownloadBtn.click(),
          ]);

          if (download) {
            const path = await download.path();
            if (path) {
              const fs = require('fs');
              const buffer = fs.readFileSync(path);
              console.log(`SUCCESS! Downloaded ${buffer.length} bytes from viewer`);
              if (viewerPage !== this.page) await viewerPage.close();
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename() || `${doc.type}.pdf`,
              };
            }
          }
        } catch (e) {
          console.log('Viewer download failed');
        }
      }

      // Step 6: Look for any PDF URLs on page
      console.log('Step 6: Searching for PDF URLs...');
      const pdfUrls = await viewerPage.evaluate(() => {
        const urls: string[] = [];
        document.querySelectorAll('a, iframe, object, embed').forEach(el => {
          const url = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data');
          if (url && (url.includes('.pdf') || url.includes('GetDocument') || url.includes('Download'))) {
            urls.push(url);
          }
        });
        return urls;
      });

      console.log(`Found ${pdfUrls.length} potential PDF URLs`);
      
      for (const pdfUrl of pdfUrls) {
        try {
          const fullUrl = pdfUrl.startsWith('http') ? pdfUrl : new URL(pdfUrl, viewerPage.url()).href;
          console.log(`Trying: ${fullUrl}`);
          const response = await viewerPage.request.get(fullUrl);
          const buffer = await response.body();
          
          if (buffer.length > 500 && buffer[0] === 0x25) {
            console.log(`SUCCESS! Got PDF from URL`);
            if (viewerPage !== this.page) await viewerPage.close();
            return {
              ...doc,
              pdfBuffer: buffer,
              filename: `${doc.type.replace(/[^a-z0-9]/gi, '_')}.pdf`,
            };
          }
        } catch (e) {
          continue;
        }
      }

      // Cleanup
      if (viewerPage !== this.page) {
        await viewerPage.close();
      }
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(1000);

      console.log('All download methods failed');
      return null;

    } catch (error) {
      console.error(`Download error: ${error}`);
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
