/**
 * IEPA Document Explorer Scraper v11
 * Network interception to capture PDF
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
      await this.page.waitForTimeout(3000);
      
      const pages = this.context.pages();
      if (pages.length < 2) {
        console.log('No new tab opened');
        return null;
      }

      const viewerPage = pages[pages.length - 1];
      console.log(`Viewer URL: ${viewerPage.url()}`);

      // Set up request interception to capture PDF
      let pdfBuffer: Buffer | null = null;
      let pdfUrl: string = '';
      
      viewerPage.on('response', async (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        
        if (contentType.includes('pdf') || url.includes('.pdf') || url.includes('GetPdf') || url.includes('Download')) {
          console.log(`Intercepted potential PDF: ${url.substring(0, 100)}`);
          console.log(`Content-Type: ${contentType}`);
          
          try {
            const buffer = await response.body();
            if (buffer.length > 1000 && buffer[0] === 0x25) {
              console.log(`Got PDF! ${buffer.length} bytes`);
              pdfBuffer = buffer;
              pdfUrl = url;
            }
          } catch (e) {
            // Response body may not be available
          }
        }
      });

      // Wait for viewer to load
      console.log('Waiting for viewer to load...');
      await viewerPage.waitForTimeout(8000);

      // If we already captured a PDF from network, return it
      if (pdfBuffer) {
        console.log('SUCCESS - captured PDF from network!');
        await viewerPage.close();
        return {
          ...doc,
          pdfBuffer: pdfBuffer,
          filename: `doc_${doc.date.replace(/\//g, '-')}.pdf`,
        };
      }

      // Find the download button and click it
      console.log('Looking for download button...');
      
      // DocuWare uses specific class names
      const downloadBtnSelectors = [
        '[data-bind*="Download"]',
        '[class*="ico-download"]',
        '[class*="download"]',
        '[title*="ownload"]',
        'button:has-text("Download")',
      ];

      for (const selector of downloadBtnSelectors) {
        const btn = await viewerPage.$(selector);
        if (btn) {
          console.log(`Found button with selector: ${selector}`);
          
          // Click to open menu
          await btn.click();
          await viewerPage.waitForTimeout(1500);
          
          // Now look for menu items containing "PDF"
          const menuItems = await viewerPage.$$('li, [role="menuitem"], [class*="menu"] a, .ui-menu-item');
          console.log(`Found ${menuItems.length} menu items`);
          
          for (const item of menuItems) {
            const text = await item.textContent();
            console.log(`Menu item: ${text?.substring(0, 50)}`);
            
            if (text && (text.toLowerCase().includes('pdf') || text.toLowerCase().includes('without'))) {
              console.log(`Clicking: ${text}`);
              
              // Set up download listener before clicking
              const downloadPromise = viewerPage.waitForEvent('download', { timeout: 15000 }).catch(() => null);
              
              await item.click();
              await viewerPage.waitForTimeout(3000);
              
              // Check if we captured PDF from network
              if (pdfBuffer) {
                console.log('SUCCESS - captured PDF after menu click!');
                await viewerPage.close();
                return {
                  ...doc,
                  pdfBuffer: pdfBuffer,
                  filename: `doc_${doc.date.replace(/\//g, '-')}.pdf`,
                };
              }
              
              // Check for download event
              const download = await downloadPromise;
              if (download) {
                console.log(`Download event: ${download.suggestedFilename()}`);
                const path = await download.path();
                if (path) {
                  const fs = require('fs');
                  const buffer = fs.readFileSync(path);
                  if (buffer.length > 1000 && buffer[0] === 0x25) {
                    console.log('SUCCESS via download event!');
                    await viewerPage.close();
                    return {
                      ...doc,
                      pdfBuffer: buffer,
                      filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
                    };
                  }
                }
              }
              
              break; // Only try one PDF menu item
            }
          }
          
          // Press Escape to close menu if it didn't work
          await viewerPage.keyboard.press('Escape');
          await viewerPage.waitForTimeout(500);
        }
      }

      // Try print to PDF as last resort
      console.log('Trying print...');
      try {
        const pdfData = await viewerPage.pdf({ format: 'A4' });
        if (pdfData.length > 1000) {
          console.log('SUCCESS via print to PDF!');
          await viewerPage.close();
          return {
            ...doc,
            pdfBuffer: Buffer.from(pdfData),
            filename: `doc_${doc.date.replace(/\//g, '-')}.pdf`,
          };
        }
      } catch (e) {
        console.log('Print to PDF failed (expected in non-headless)');
      }

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
