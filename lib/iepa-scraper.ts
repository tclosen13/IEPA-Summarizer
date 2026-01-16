/**
 * IEPA Document Explorer Scraper v9
 * Better DocuWare viewer PDF extraction
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

    const docuwareHref = await this.page.evaluate(() => {
      const allLinks = document.querySelectorAll('a');
      for (let i = 0; i < allLinks.length; i++) {
        const href = allLinks[i].getAttribute('href') || '';
        if (href.toLowerCase().includes('docuware')) return href;
      }
      return null;
    });

    if (!docuwareHref) {
      console.log('No DocuWare link found');
      return [];
    }

    this.docuwareUrl = docuwareHref.startsWith('http') ? docuwareHref : `https://webapps.illinois.gov${docuwareHref}`;
    console.log(`Opening DocuWare: ${this.docuwareUrl}`);

    await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
    console.log('Waiting for SlickGrid...');
    await this.page.waitForTimeout(8000);

    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      const gridCanvas = document.querySelector('.grid-canvas');
      
      if (gridCanvas) {
        const children = gridCanvas.children;
        for (let idx = 0; idx < children.length; idx++) {
          const row = children[idx];
          const rowText = row.textContent || '';
          const dateMatch = rowText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
          const cells = row.querySelectorAll('.slick-cell');
          const cellTexts: string[] = [];
          cells.forEach(c => {
            const text = c.textContent?.trim();
            if (text) cellTexts.push(text);
          });
          
          if (dateMatch || cellTexts.length > 0) {
            docs.push({
              id: 'slick-' + idx,
              type: cellTexts[0] || 'Document',
              date: dateMatch ? dateMatch[0] : 'Unknown',
              category: 'LUST Technical',
              description: cellTexts.slice(1, 4).filter(t => t).join(' | '),
              rowIndex: idx,
            });
          }
        }
      }
      
      if (docs.length === 0) {
        const allText = document.body.innerText;
        const dates = allText.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
        const uniqueDates = [...new Set(dates)];
        uniqueDates.forEach((date, idx) => {
          docs.push({
            id: 'date-' + idx,
            type: 'Document',
            date: date,
            category: 'LUST Technical',
            description: 'Document from ' + date,
            rowIndex: idx,
          });
        });
      }
      
      return docs;
    });

    console.log(`Found ${documents.length} documents`);
    return documents;
  }

  async downloadDocument(doc: DocumentInfo): Promise<DownloadedDocument | null> {
    if (!this.page || !this.context) throw new Error('Not initialized');

    const rowIdx = doc.rowIndex ?? 0;
    console.log(`\n=== Downloading document ${rowIdx}: ${doc.date} ===`);

    try {
      // Make sure we're on DocuWare
      if (!this.page.url().toLowerCase().includes('docuware') && this.docuwareUrl) {
        await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await this.page.waitForTimeout(8000);
      }

      const rows = await this.page.$$('.grid-canvas > div');
      console.log(`Found ${rows.length} rows`);

      if (rowIdx >= rows.length) {
        console.log(`Row ${rowIdx} out of range`);
        return null;
      }

      // Double-click to open viewer
      console.log('Double-clicking row...');
      await rows[rowIdx].dblclick();
      
      // Wait for new tab to open
      await this.page.waitForTimeout(3000);
      
      const pages = this.context.pages();
      if (pages.length < 2) {
        console.log('No new tab opened');
        return null;
      }

      const viewerPage = pages[pages.length - 1];
      console.log(`Viewer URL: ${viewerPage.url()}`);

      // Wait longer for viewer to fully load the PDF
      console.log('Waiting for viewer to load PDF...');
      await viewerPage.waitForTimeout(8000);

      // Try to intercept PDF requests by looking at what the viewer loaded
      // DocuWare typically loads PDF via XHR/fetch
      
      // Method 1: Look for canvas (PDF.js renders to canvas)
      const hasCanvas = await viewerPage.$('canvas');
      if (hasCanvas) {
        console.log('Found canvas - PDF is rendered');
      }

      // Method 2: Find the actual PDF download endpoint
      // DocuWare uses specific API endpoints for PDF download
      const pdfEndpoint = await viewerPage.evaluate(() => {
        // Check for any elements with PDF-related attributes
        const allElements = document.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const attrs = el.attributes;
          for (let j = 0; j < attrs.length; j++) {
            const attr = attrs[j];
            if (attr.value && (
              attr.value.includes('GetDocument') ||
              attr.value.includes('Download') ||
              attr.value.includes('.pdf') ||
              attr.value.includes('FileCabinet')
            )) {
              return { attr: attr.name, value: attr.value };
            }
          }
        }
        
        // Check script content for PDF URLs
        const scripts = document.querySelectorAll('script');
        for (let i = 0; i < scripts.length; i++) {
          const content = scripts[i].textContent || '';
          const match = content.match(/["'](https?:\/\/[^"']*(?:GetDocument|Download|\.pdf)[^"']*)/i);
          if (match) return { attr: 'script', value: match[1] };
        }

        // Check for data attributes
        const viewer = document.querySelector('[class*="viewer"], [class*="Viewer"]');
        if (viewer) {
          return { 
            attr: 'viewer-class', 
            value: viewer.className,
            html: viewer.innerHTML.substring(0, 500)
          };
        }

        return null;
      });

      console.log('PDF endpoint search:', JSON.stringify(pdfEndpoint));

      // Method 3: Use keyboard shortcut Ctrl+S
      console.log('Trying Ctrl+S...');
      try {
        const downloadPromise = viewerPage.waitForEvent('download', { timeout: 10000 });
        await viewerPage.keyboard.press('Control+s');
        const download = await downloadPromise;
        
        if (download) {
          console.log(`Ctrl+S triggered download: ${download.suggestedFilename()}`);
          const path = await download.path();
          if (path) {
            const fs = require('fs');
            const buffer = fs.readFileSync(path);
            if (buffer[0] === 0x25) {
              console.log('SUCCESS via Ctrl+S!');
              await viewerPage.close();
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
              };
            }
          }
        }
      } catch (e) {
        console.log('Ctrl+S failed');
      }

      // Method 4: Look for print/download menu
      console.log('Looking for menu buttons...');
      const menuButtons = await viewerPage.$$('[class*="menu"], [class*="Menu"], [class*="toolbar"], [class*="Toolbar"]');
      console.log(`Found ${menuButtons.length} menu/toolbar elements`);

      // Try clicking on common download icons
      const downloadIcons = [
        '[class*="download"]',
        '[class*="Download"]',
        '[title*="ownload"]',
        '[aria-label*="ownload"]',
        'button[class*="save"]',
        'button[class*="Save"]',
        '[class*="ico-download"]',
        '[class*="pdf"]',
        'a[download]',
      ];

      for (const selector of downloadIcons) {
        try {
          const btn = await viewerPage.$(selector);
          if (btn) {
            console.log(`Found button: ${selector}`);
            const downloadPromise = viewerPage.waitForEvent('download', { timeout: 10000 });
            await btn.click();
            
            try {
              const download = await downloadPromise;
              const path = await download.path();
              if (path) {
                const fs = require('fs');
                const buffer = fs.readFileSync(path);
                if (buffer.length > 1000 && buffer[0] === 0x25) {
                  console.log(`SUCCESS via ${selector}!`);
                  await viewerPage.close();
                  return {
                    ...doc,
                    pdfBuffer: buffer,
                    filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
                  };
                }
              }
            } catch (e) {
              console.log(`${selector} didn't trigger download`);
            }
          }
        } catch (e) {
          continue;
        }
      }

      // Method 5: Check network requests for PDF
      // (This would require setting up request interception earlier)
      
      // Method 6: Take the viewer URL and try common DocuWare API patterns
      const viewerUrl = viewerPage.url();
      const authMatch = viewerUrl.match(/_auth=([^&]+)/);
      if (authMatch) {
        const auth = authMatch[1];
        // Try common DocuWare download endpoints
        const downloadUrls = [
          `https://docuware7.illinois.gov/DocuWare/PlatformRO/WebClient/Client/Document?_auth=${auth}`,
          `https://docuware7.illinois.gov/DocuWare/Platform/FileCabinets/Download?_auth=${auth}`,
        ];
        
        for (const downloadUrl of downloadUrls) {
          try {
            console.log(`Trying: ${downloadUrl.substring(0, 80)}...`);
            const response = await viewerPage.request.get(downloadUrl);
            const buffer = await response.body();
            console.log(`Got ${buffer.length} bytes, first: ${buffer[0]}`);
            
            if (buffer.length > 1000 && buffer[0] === 0x25) {
              console.log('SUCCESS via direct URL!');
              await viewerPage.close();
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: `doc_${doc.date.replace(/\//g, '-')}.pdf`,
              };
            }
          } catch (e) {
            console.log('URL failed');
          }
        }
      }

      // Cleanup
      await viewerPage.close();
      console.log('All methods failed');
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
