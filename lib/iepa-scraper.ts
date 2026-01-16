/**
 * IEPA Document Explorer Scraper v10
 * DocuWare Knockout.js menu-based download
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

      // Wait for viewer to fully load
      console.log('Waiting for viewer...');
      await viewerPage.waitForTimeout(10000);

      // Find and log all buttons/clickable elements
      const buttons = await viewerPage.evaluate(() => {
        const result: any[] = [];
        document.querySelectorAll('button, a, [role="button"], [data-bind]').forEach((el, i) => {
          const text = el.textContent?.trim().substring(0, 50);
          const dataBind = el.getAttribute('data-bind');
          const className = el.className;
          const title = el.getAttribute('title');
          
          if (dataBind?.includes('ownload') || text?.toLowerCase().includes('download') || 
              className?.toLowerCase().includes('download') || title?.toLowerCase().includes('download')) {
            result.push({
              index: i,
              tag: el.tagName,
              text,
              dataBind: dataBind?.substring(0, 100),
              class: className?.substring(0, 50),
              title
            });
          }
        });
        return result;
      });
      
      console.log('Download-related elements:', JSON.stringify(buttons, null, 2));

      // Try clicking elements with download data-bind
      for (const btn of buttons) {
        try {
          console.log(`Trying element: ${btn.tag} - ${btn.text || btn.title || btn.class}`);
          
          // Find the element
          let element = null;
          if (btn.dataBind) {
            element = await viewerPage.$(`[data-bind*="Download"]`);
          }
          if (!element && btn.title) {
            element = await viewerPage.$(`[title="${btn.title}"]`);
          }
          if (!element && btn.class) {
            element = await viewerPage.$(`.${btn.class.split(' ')[0]}`);
          }
          
          if (element) {
            // Click to open dropdown menu
            console.log('Clicking download button...');
            await element.click();
            await viewerPage.waitForTimeout(2000);
            
            // Look for dropdown menu items
            const menuItems = await viewerPage.evaluate(() => {
              const items: any[] = [];
              // Look for visible menu items
              document.querySelectorAll('[class*="menu"] li, [class*="dropdown"] li, [class*="Menu"] a, ul li a, [role="menuitem"]').forEach((item, i) => {
                const text = item.textContent?.trim();
                const style = window.getComputedStyle(item);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  items.push({ index: i, text });
                }
              });
              return items;
            });
            
            console.log('Menu items found:', JSON.stringify(menuItems));
            
            // Find "PDF without annotations" or similar
            for (const item of menuItems) {
              if (item.text && (
                item.text.toLowerCase().includes('pdf') || 
                item.text.toLowerCase().includes('download') ||
                item.text.toLowerCase().includes('without')
              )) {
                console.log(`Clicking menu item: ${item.text}`);
                
                // Click the menu item
                const menuItem = await viewerPage.$(`text=${item.text}`);
                if (menuItem) {
                  const downloadPromise = viewerPage.waitForEvent('download', { timeout: 30000 });
                  await menuItem.click();
                  
                  try {
                    const download = await downloadPromise;
                    console.log(`Download started: ${download.suggestedFilename()}`);
                    const path = await download.path();
                    if (path) {
                      const fs = require('fs');
                      const buffer = fs.readFileSync(path);
                      if (buffer.length > 1000 && buffer[0] === 0x25) {
                        console.log('SUCCESS!');
                        await viewerPage.close();
                        return {
                          ...doc,
                          pdfBuffer: buffer,
                          filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
                        };
                      }
                    }
                  } catch (e) {
                    console.log('Menu item download failed');
                  }
                }
              }
            }
            
            // If no menu appeared, try clicking any visible download option
            const pdfOption = await viewerPage.$('text=/PDF|Download/i');
            if (pdfOption) {
              console.log('Found PDF/Download text, clicking...');
              const downloadPromise = viewerPage.waitForEvent('download', { timeout: 30000 });
              await pdfOption.click();
              
              try {
                const download = await downloadPromise;
                const path = await download.path();
                if (path) {
                  const fs = require('fs');
                  const buffer = fs.readFileSync(path);
                  if (buffer.length > 1000 && buffer[0] === 0x25) {
                    console.log('SUCCESS via PDF option!');
                    await viewerPage.close();
                    return {
                      ...doc,
                      pdfBuffer: buffer,
                      filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
                    };
                  }
                }
              } catch (e) {
                console.log('PDF option failed');
              }
            }
          }
        } catch (e) {
          console.log('Button click failed:', e);
        }
      }

      // Method: Try right-click on document
      console.log('Trying right-click context menu...');
      try {
        const canvas = await viewerPage.$('canvas');
        if (canvas) {
          await canvas.click({ button: 'right' });
          await viewerPage.waitForTimeout(1500);
          
          // Look for context menu
          const contextItems = await viewerPage.evaluate(() => {
            const items: string[] = [];
            document.querySelectorAll('[class*="context"] li, [class*="menu"] li').forEach(item => {
              const text = item.textContent?.trim();
              if (text) items.push(text);
            });
            return items;
          });
          
          console.log('Context menu items:', contextItems);
          
          // Click on PDF download option
          const pdfItem = await viewerPage.$('text=/Download.*PDF|PDF.*without/i');
          if (pdfItem) {
            const downloadPromise = viewerPage.waitForEvent('download', { timeout: 30000 });
            await pdfItem.click();
            
            try {
              const download = await downloadPromise;
              const path = await download.path();
              if (path) {
                const fs = require('fs');
                const buffer = fs.readFileSync(path);
                if (buffer.length > 1000 && buffer[0] === 0x25) {
                  console.log('SUCCESS via context menu!');
                  await viewerPage.close();
                  return {
                    ...doc,
                    pdfBuffer: buffer,
                    filename: download.suggestedFilename() || `doc_${doc.date}.pdf`,
                  };
                }
              }
            } catch (e) {
              console.log('Context menu download failed');
            }
          }
        }
      } catch (e) {
        console.log('Right-click failed:', e);
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
