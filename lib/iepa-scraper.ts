/**
 * IEPA Document Explorer Scraper v4
 * Uses DocuWare toolbar download button
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

    // Fill and submit search
    const nameField = await this.page.$('#Name, input[name="Name"]');
    if (nameField) await nameField.fill(query.trim());
    
    await this.page.click('button[type="submit"], .btn-primary');
    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(3000);

    // Get results
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
    
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(2000);

    // Find and click DocuWare link
    const docuwareLink = await this.page.$('a[href*="docuware" i]');
    if (!docuwareLink) {
      console.log('No DocuWare link found');
      return [];
    }

    const href = await docuwareLink.getAttribute('href');
    if (!href) return [];

    this.docuwareUrl = href;
    console.log(`Opening DocuWare: ${href}`);

    // Open DocuWare
    await this.page.goto(href, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(5000);

    // Get document list
    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      const rows = document.querySelectorAll('table tbody tr, [class*="Row"]:not([class*="Header"])');
      
      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td, [class*="Cell"]');
        if (cells.length >= 3) {
          const texts = Array.from(cells).map(c => c.textContent?.trim() || '');
          let date = texts.find(t => /\d{1,2}\/\d{1,2}\/\d{4}/.test(t)) || '';
          
          docs.push({
            id: `dw-${idx}`,
            type: texts[0] || 'Document',
            date: date,
            category: 'LUST',
            description: texts.slice(1, 4).join(' | '),
            rowIndex: idx,
          });
        }
      });
      return docs;
    });

    console.log(`Found ${documents.length} documents`);
    return documents;
  }

  async downloadDocument(doc: DocumentInfo): Promise<DownloadedDocument | null> {
    if (!this.page || !this.context) throw new Error('Not initialized');

    const rowIdx = doc.rowIndex ?? 0;
    console.log(`Downloading row ${rowIdx}: ${doc.type} (${doc.date})`);

    try {
      // Make sure we're on DocuWare
      const currentUrl = this.page.url();
      if (!currentUrl.includes('docuware') && this.docuwareUrl) {
        await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await this.page.waitForTimeout(5000);
      }

      // Get all rows
      const rows = await this.page.$$('table tbody tr');
      if (rowIdx >= rows.length) {
        console.log(`Row ${rowIdx} not found`);
        return null;
      }

      // Click the row to select it
      console.log('Clicking row to select...');
      await rows[rowIdx].click();
      await this.page.waitForTimeout(2000);

      // Look for download button in toolbar
      // Common selectors for download buttons
      const downloadSelectors = [
        'button[title*="ownload" i]',
        'a[title*="ownload" i]',
        '[class*="download" i]',
        '[aria-label*="ownload" i]',
        'button[class*="toolbar"] svg',
        '.toolbar button',
        '[class*="action"] button',
        'button:has(svg[class*="download"])',
        // DocuWare specific
        '[data-dw-action*="download" i]',
        '[class*="ResultListToolbar"] button',
        '[class*="Toolbar"] [class*="Download"]',
      ];

      let downloadButton = null;
      for (const sel of downloadSelectors) {
        try {
          downloadButton = await this.page.$(sel);
          if (downloadButton) {
            const isVisible = await downloadButton.isVisible();
            if (isVisible) {
              console.log(`Found download button: ${sel}`);
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }

      // Try clicking download and catching the download event
      if (downloadButton) {
        try {
          const [download] = await Promise.all([
            this.page.waitForEvent('download', { timeout: 20000 }),
            downloadButton.click(),
          ]);

          if (download) {
            console.log(`Download started: ${download.suggestedFilename()}`);
            const path = await download.path();
            if (path) {
              const fs = require('fs');
              const buffer = fs.readFileSync(path);
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename() || `${doc.type}.pdf`,
              };
            }
          }
        } catch (e) {
          console.log('Toolbar download failed, trying double-click...');
        }
      }

      // Method 2: Double-click to open viewer
      console.log('Trying double-click to open viewer...');
      await rows[rowIdx].dblclick();
      await this.page.waitForTimeout(5000);

      // Check for new page/popup
      const pages = this.context.pages();
      let viewerPage = pages.length > 1 ? pages[pages.length - 1] : this.page;

      if (viewerPage !== this.page) {
        console.log('New viewer page opened');
        await viewerPage.waitForTimeout(3000);
      }

      // Look for PDF content or download in viewer
      // Check for iframe with PDF
      const iframe = await viewerPage.$('iframe[src*="pdf" i], iframe[src*="GetDocument"]');
      if (iframe) {
        const src = await iframe.getAttribute('src');
        if (src) {
          console.log(`Found PDF iframe: ${src}`);
          try {
            const fullUrl = src.startsWith('http') ? src : new URL(src, viewerPage.url()).href;
            const response = await viewerPage.request.get(fullUrl);
            const buffer = await response.body();
            
            if (buffer.length > 500 && buffer[0] === 0x25) {
              if (viewerPage !== this.page) await viewerPage.close();
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: `${doc.type.replace(/[^a-z0-9]/gi, '_')}.pdf`,
              };
            }
          } catch (e) {
            console.log('Iframe fetch failed:', e);
          }
        }
      }

      // Look for download button in viewer
      const viewerDownloadBtn = await viewerPage.$('[title*="ownload" i], [class*="download" i], button:has-text("Download")');
      if (viewerDownloadBtn) {
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

      // Look for any PDF URLs
      const pdfUrls = await viewerPage.evaluate(() => {
        const urls: string[] = [];
        document.querySelectorAll('a[href*=".pdf" i], a[href*="GetDocument"], iframe[src*="GetDocument"]').forEach(el => {
          const url = el.getAttribute('href') || el.getAttribute('src');
          if (url) urls.push(url);
        });
        // Also check for embedded object/embed
        document.querySelectorAll('object[data], embed[src]').forEach(el => {
          const url = el.getAttribute('data') || el.getAttribute('src');
          if (url) urls.push(url);
        });
        return urls;
      });

      for (const pdfUrl of pdfUrls) {
        try {
          const fullUrl = pdfUrl.startsWith('http') ? pdfUrl : new URL(pdfUrl, viewerPage.url()).href;
          console.log(`Trying PDF URL: ${fullUrl}`);
          const response = await viewerPage.request.get(fullUrl);
          const buffer = await response.body();
          
          if (buffer.length > 500 && buffer[0] === 0x25) {
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

      // Close viewer if separate
      if (viewerPage !== this.page) {
        await viewerPage.close();
      }

      // Press Escape to close any modals
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
