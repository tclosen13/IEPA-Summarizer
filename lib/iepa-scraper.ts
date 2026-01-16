/**
 * IEPA Document Explorer Scraper v7
 * SlickGrid support for DocuWare
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

    await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
    
    console.log('Waiting for DocuWare SlickGrid to load...');
    await this.page.waitForTimeout(8000);

    // Wait for SlickGrid to render
    try {
      await this.page.waitForSelector('.grid-canvas, .slick-row, [class*="slick"]', { timeout: 10000 });
      console.log('SlickGrid detected');
    } catch (e) {
      console.log('SlickGrid not found, trying alternatives...');
    }

    // Extract documents from SlickGrid
    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      
      // SlickGrid stores rows in .grid-canvas as direct children divs
      // Each row has class like "slick-row" or just child divs of grid-canvas
      const gridCanvas = document.querySelector('.grid-canvas, [class*="grid-canvas"]');
      
      if (gridCanvas) {
        console.log(`Found grid-canvas with ${gridCanvas.children.length} children`);
        
        // Each child of grid-canvas is a row
        Array.from(gridCanvas.children).forEach((row, idx) => {
          // Each row contains cells with class like "slick-cell" or just divs
          const cells = row.querySelectorAll('.slick-cell, [class*="slick-cell"], > div');
          const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');
          
          // Also try getting text from the whole row
          const rowText = row.textContent || '';
          
          // Find date in row
          const dateMatch = rowText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
          const date = dateMatch ? dateMatch[0] : '';
          
          if (date || cellTexts.length > 0) {
            docs.push({
              id: `slick-${idx}`,
              type: cellTexts[0] || 'Document',
              date: date || 'Unknown',
              category: 'LUST Technical',
              description: cellTexts.slice(1, 4).filter(t => t).join(' | ') || rowText.substring(0, 100),
              rowIndex: idx,
            });
          }
        });
      }
      
      // Fallback: look for any divs containing dates
      if (docs.length === 0) {
        console.log('Trying date-based detection...');
        const allText = document.body.innerText;
        const dates = allText.match(/\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
        const uniqueDates = [...new Set(dates)];
        
        uniqueDates.forEach((date, idx) => {
          docs.push({
            id: `date-${idx}`,
            type: 'Document',
            date: date,
            category: 'LUST Technical',
            description: `Document from ${date}`,
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
        console.log('Navigating to DocuWare...');
        await this.page.goto(this.docuwareUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await this.page.waitForTimeout(8000);
      }

      // Find SlickGrid rows
      const gridCanvas = await this.page.$('.grid-canvas, [class*="grid-canvas"]');
      if (!gridCanvas) {
        console.log('Grid canvas not found');
        return null;
      }

      const rows = await gridCanvas.$$(':scope > div, .slick-row');
      console.log(`Found ${rows.length} SlickGrid rows`);

      if (rowIdx >= rows.length) {
        console.log(`Row ${rowIdx} out of range`);
        return null;
      }

      const targetRow = rows[rowIdx];

      // Step 1: Click to select the row
      console.log('Clicking row to select...');
      await targetRow.click();
      await this.page.waitForTimeout(2000);

      // Step 2: Double-click to open the document viewer
      console.log('Double-clicking to open document...');
      await targetRow.dblclick();
      await this.page.waitForTimeout(6000);

      // Check for new pages/tabs
      const pages = this.context.pages();
      console.log(`Total open pages: ${pages.length}`);
      
      let viewerPage = pages[pages.length - 1];
      if (viewerPage !== this.page) {
        console.log(`Viewer opened in new tab: ${viewerPage.url()}`);
        await viewerPage.waitForTimeout(4000);
      }

      // Try to find PDF source
      console.log('Looking for PDF...');
      
      // Method 1: Check for iframe/object/embed with PDF
      const pdfSource = await viewerPage.evaluate(() => {
        // Check iframes
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          if (iframe.src && (iframe.src.includes('.pdf') || iframe.src.includes('GetDocument') || iframe.src.includes('Viewer'))) {
            return { type: 'iframe', src: iframe.src };
          }
        }
        
        // Check objects
        const objects = document.querySelectorAll('object');
        for (const obj of objects) {
          if (obj.data) return { type: 'object', src: obj.data };
        }
        
        // Check embeds
        const embeds = document.querySelectorAll('embed');
        for (const embed of embeds) {
          if (embed.src) return { type: 'embed', src: embed.src };
        }

        // Check for PDF.js canvas (some viewers use this)
        const canvas = document.querySelector('canvas');
        if (canvas) {
          const parent = canvas.closest('[class*="viewer"], [class*="pdf"]');
          if (parent) return { type: 'canvas', src: null };
        }

        // Look for download links
        const links = document.querySelectorAll('a');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const text = link.textContent?.toLowerCase() || '';
          if (href.includes('.pdf') || href.includes('GetDocument') || href.includes('Download') ||
              text.includes('download') || text.includes('pdf')) {
            return { type: 'link', src: href };
          }
        }

        // Look for buttons with download functionality
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() || '';
          const title = btn.getAttribute('title')?.toLowerCase() || '';
          if (text.includes('download') || title.includes('download')) {
            return { type: 'button', src: null };
          }
        }

        return null;
      });

      console.log('PDF source found:', pdfSource);

      if (pdfSource?.src) {
        try {
          const fullUrl = pdfSource.src.startsWith('http') ? pdfSource.src : new URL(pdfSource.src, viewerPage.url()).href;
          console.log(`Fetching PDF from: ${fullUrl}`);
          
          const response = await viewerPage.request.get(fullUrl);
          const buffer = await response.body();
          
          console.log(`Got ${buffer.length} bytes, first byte: ${buffer[0]}`);
          
          if (buffer.length > 500 && buffer[0] === 0x25) { // %PDF
            console.log('SUCCESS! Valid PDF received');
            if (viewerPage !== this.page) await viewerPage.close();
            return {
              ...doc,
              pdfBuffer: buffer,
              filename: `doc_${doc.date.replace(/\//g, '-')}.pdf`,
            };
          }
        } catch (e) {
          console.log('PDF fetch error:', e);
        }
      }

      // Method 2: Click download button
      console.log('Trying download button...');
      const downloadBtn = await viewerPage.$('[title*="ownload" i], [class*="download" i], button:has-text("Download"), a:has-text("Download")');
      
      if (downloadBtn) {
        console.log('Found download button, clicking...');
        try {
          const [download] = await Promise.all([
            viewerPage.waitForEvent('download', { timeout: 20000 }),
            downloadBtn.click(),
          ]);
          
          if (download) {
            console.log(`Download started: ${download.suggestedFilename()}`);
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
          console.log('Download button click failed:', e);
        }
      }

      // Method 3: Try right-click context menu
      console.log('Trying right-click download...');
      try {
        // Find the document area
        const docArea = await viewerPage.$('canvas, [class*="viewer"], [class*="document"], img, object, embed');
        if (docArea) {
          await docArea.click({ button: 'right' });
          await viewerPage.waitForTimeout(1000);
          
          // Look for "Download as PDF" or similar option
          const menuItem = await viewerPage.$('text=/download|save|pdf/i');
          if (menuItem) {
            const [download] = await Promise.all([
              viewerPage.waitForEvent('download', { timeout: 15000 }),
              menuItem.click(),
            ]);
            
            if (download) {
              const path = await download.path();
              if (path) {
                const fs = require('fs');
                const buffer = fs.readFileSync(path);
                console.log(`SUCCESS via context menu! ${buffer.length} bytes`);
                if (viewerPage !== this.page) await viewerPage.close();
                return {
                  ...doc,
                  pdfBuffer: buffer,
                  filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
                };
              }
            }
          }
        }
      } catch (e) {
        console.log('Right-click method failed');
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
