/**
 * IEPA Document Explorer Scraper v2
 * Enhanced DocuWare PDF download support
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

  async init(): Promise<void> {
    if (this.isInitialized) return;

    console.log('Initializing Playwright browser...');
    
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--allow-running-insecure-content',
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
    });

    this.page = await this.context.newPage();
    this.isInitialized = true;
    console.log('Browser initialized');
  }

  async searchFacilities(query: string): Promise<FacilityResult[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Searching for facilities: "${query}"`);

    await this.page.goto('https://webapps.illinois.gov/EPA/DocumentExplorer/Attributes', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await this.page.waitForTimeout(3000);
    console.log('Page loaded, looking for search form...');

    const nameSelectors = [
      '#Name',
      'input[name="Name"]',
      'input[id="Name"]',
      '[data-val-required*="Name"]',
      'input[placeholder*="name" i]',
      'form input[type="text"]:first-of-type'
    ];

    let filled = false;
    for (const selector of nameSelectors) {
      try {
        const field = await this.page.$(selector);
        if (field) {
          await field.fill(query.trim());
          console.log(`Filled search field using selector: ${selector}`);
          filled = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!filled) {
      const inputs = await this.page.$$('input[type="text"]:visible');
      if (inputs.length > 0) {
        await inputs[0].fill(query.trim());
        console.log('Filled first visible text input');
        filled = true;
      }
    }

    if (!filled) {
      throw new Error('Could not find search input field');
    }

    const buttonSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Search")',
      '.btn-primary',
      '#btnSearch',
      'button.btn'
    ];

    let clicked = false;
    for (const selector of buttonSelectors) {
      try {
        const button = await this.page.$(selector);
        if (button) {
          await button.click();
          console.log(`Clicked button using selector: ${selector}`);
          clicked = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!clicked) {
      await this.page.keyboard.press('Enter');
      console.log('Pressed Enter to submit');
    }

    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(3000);

    const facilities = await this.page.evaluate(() => {
      const results: any[] = [];
      
      const selectors = [
        'table tbody tr',
        '.search-results tr',
        '.facility-item',
        '[data-facility-id]',
        'a[href*="/Facility/"]',
        'a[href*="/Documents/"]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el, index) => {
            const link = el.querySelector('a[href*="Facility"]') || 
                        el.querySelector('a[href*="Documents"]') ||
                        (el.tagName === 'A' ? el : null);
            
            if (link) {
              const href = link.getAttribute('href') || '';
              const idMatch = href.match(/\/(\d+)(?:$|\/|\?)/);
              
              const cells = el.querySelectorAll('td');
              let name = link.textContent?.trim() || '';
              let address = '';
              let city = '';
              let county = '';
              let zip = '';

              if (cells.length >= 1) name = cells[0]?.textContent?.trim() || name;
              if (cells.length >= 2) address = cells[1]?.textContent?.trim() || '';
              if (cells.length >= 3) city = cells[2]?.textContent?.trim() || '';
              if (cells.length >= 4) county = cells[3]?.textContent?.trim() || '';
              if (cells.length >= 5) zip = cells[4]?.textContent?.trim() || '';

              if (idMatch || href) {
                results.push({
                  id: idMatch ? idMatch[1] : href,
                  name: name || `Facility ${index + 1}`,
                  address,
                  city,
                  county,
                  zip,
                  programs: [],
                  link: href.startsWith('http') ? href : `https://webapps.illinois.gov${href}`,
                });
              }
            }
          });
          
          if (results.length > 0) break;
        }
      }

      return results;
    });

    console.log(`Found ${facilities.length} facilities`);
    return facilities;
  }

  async getFacilityDocuments(facilityId: string): Promise<DocumentInfo[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Getting documents for facility: ${facilityId}`);

    const url = facilityId.startsWith('http') 
      ? facilityId 
      : `https://webapps.illinois.gov/EPA/DocumentExplorer/Documents/Index/${facilityId}`;
    
    await this.page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await this.page.waitForTimeout(3000);

    // Click on document category links to open DocuWare
    const categoryLinks = await this.page.$$('a[href*="docuware"], a[href*="DocuWare"], a.document-link, td a');
    
    const documents: DocumentInfo[] = [];
    
    for (let i = 0; i < categoryLinks.length && i < 5; i++) {
      try {
        const linkText = await categoryLinks[i].textContent();
        const href = await categoryLinks[i].getAttribute('href');
        
        if (href && (href.includes('docuware') || href.includes('DocuWare'))) {
          console.log(`Found DocuWare link: ${linkText}`);
          
          // Open DocuWare in new page
          const docuwarePage = await this.context!.newPage();
          await docuwarePage.goto(href, { waitUntil: 'networkidle', timeout: 30000 });
          await docuwarePage.waitForTimeout(3000);
          
          // Extract documents from DocuWare grid
          const docuwareDocs = await docuwarePage.evaluate(() => {
            const docs: any[] = [];
            
            // Look for table rows in DocuWare
            const rows = document.querySelectorAll('table tbody tr, .result-row, [class*="row"]');
            
            rows.forEach((row, idx) => {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 3) {
                const type = cells[0]?.textContent?.trim() || 'Document';
                const bureauId = cells[1]?.textContent?.trim() || '';
                const siteName = cells[2]?.textContent?.trim() || '';
                const date = cells[3]?.textContent?.trim() || '';
                
                docs.push({
                  id: `docuware-${idx}`,
                  type: type,
                  date: date,
                  category: 'DocuWare',
                  description: `${siteName} - ${bureauId}`,
                  rowIndex: idx
                });
              }
            });
            
            return docs;
          });
          
          // Store the DocuWare page URL for later
          const docuwareUrl = docuwarePage.url();
          
          docuwareDocs.forEach((doc: any) => {
            documents.push({
              ...doc,
              viewerUrl: docuwareUrl,
            });
          });
          
          await docuwarePage.close();
        }
      } catch (e) {
        console.log(`Error processing link ${i}:`, e);
      }
    }

    // If no DocuWare docs found, try to get docs from main page
    if (documents.length === 0) {
      const pageDocs = await this.page.evaluate(() => {
        const docs: any[] = [];
        const links = document.querySelectorAll('a');
        
        links.forEach((link, idx) => {
          const href = link.getAttribute('href') || '';
          const text = link.textContent?.trim() || '';
          
          if (href.includes('docuware') || href.includes('DocuWare') || 
              text.toLowerCase().includes('technical') || 
              text.toLowerCase().includes('document')) {
            docs.push({
              id: `doc-${idx}`,
              type: text.substring(0, 50) || 'Document',
              date: 'Unknown',
              category: 'IEPA Document',
              description: text,
              viewerUrl: href.startsWith('http') ? href : `https://webapps.illinois.gov${href}`,
            });
          }
        });
        
        return docs;
      });
      
      documents.push(...pageDocs);
    }

    console.log(`Found ${documents.length} documents`);
    return documents;
  }

  async downloadDocument(doc: DocumentInfo): Promise<DownloadedDocument | null> {
    if (!this.context) throw new Error('Browser not initialized');

    console.log(`Attempting download: ${doc.type} (${doc.date})`);

    try {
      if (!doc.viewerUrl) {
        console.log('No viewer URL');
        return null;
      }

      const downloadPage = await this.context.newPage();
      
      try {
        // Go to DocuWare URL
        await downloadPage.goto(doc.viewerUrl, {
          waitUntil: 'networkidle',
          timeout: 45000,
        });
        
        await downloadPage.waitForTimeout(3000);
        
        console.log(`Opened page: ${downloadPage.url()}`);

        // If this is a DocuWare results page, click on specific document row
        if (doc.id.startsWith('docuware-')) {
          const rowIndex = parseInt(doc.id.replace('docuware-', ''));
          
          // Click on the row to select it
          const rows = await downloadPage.$$('table tbody tr');
          if (rows[rowIndex]) {
            await rows[rowIndex].click();
            await downloadPage.waitForTimeout(2000);
          }
        }

        // Method 1: Look for download button
        const downloadButtons = [
          'button:has-text("Download")',
          'a:has-text("Download")',
          '[title*="Download"]',
          '[class*="download"]',
          'button[class*="pdf"]',
          'a[href*=".pdf"]',
        ];

        for (const selector of downloadButtons) {
          try {
            const btn = await downloadPage.$(selector);
            if (btn) {
              console.log(`Found download button: ${selector}`);
              
              // Set up download listener
              const downloadPromise = downloadPage.waitForEvent('download', { timeout: 15000 });
              await btn.click();
              
              try {
                const download = await downloadPromise;
                const filePath = await download.path();
                if (filePath) {
                  const fs = require('fs');
                  const buffer = fs.readFileSync(filePath);
                  await downloadPage.close();
                  
                  console.log(`Downloaded via button: ${download.suggestedFilename()}`);
                  return {
                    ...doc,
                    pdfBuffer: buffer,
                    filename: download.suggestedFilename(),
                  };
                }
              } catch (e) {
                console.log('Download event timed out, trying next method...');
              }
            }
          } catch (e) {
            continue;
          }
        }

        // Method 2: Right-click context menu
        try {
          const docIcon = await downloadPage.$('.document-icon, [class*="doc-icon"], table tbody tr:first-child');
          if (docIcon) {
            await docIcon.click({ button: 'right' });
            await downloadPage.waitForTimeout(1000);
            
            const contextDownload = await downloadPage.$('text=Download, text=Save, [class*="download"]');
            if (contextDownload) {
              const downloadPromise = downloadPage.waitForEvent('download', { timeout: 15000 });
              await contextDownload.click();
              
              try {
                const download = await downloadPromise;
                const filePath = await download.path();
                if (filePath) {
                  const fs = require('fs');
                  const buffer = fs.readFileSync(filePath);
                  await downloadPage.close();
                  
                  console.log(`Downloaded via context menu`);
                  return {
                    ...doc,
                    pdfBuffer: buffer,
                    filename: download.suggestedFilename(),
                  };
                }
              } catch (e) {
                console.log('Context menu download failed');
              }
            }
          }
        } catch (e) {
          console.log('Context menu method failed');
        }

        // Method 3: Look for iframe with PDF
        try {
          const iframe = await downloadPage.$('iframe[src*=".pdf"], iframe[src*="viewer"], iframe[src*="DocuWare"]');
          if (iframe) {
            const src = await iframe.getAttribute('src');
            if (src) {
              console.log(`Found iframe: ${src}`);
              const response = await downloadPage.request.get(src);
              const buffer = await response.body();
              
              // Check if it's a PDF
              if (buffer[0] === 0x25 && buffer[1] === 0x50) { // %P
                await downloadPage.close();
                console.log('Downloaded from iframe');
                return {
                  ...doc,
                  pdfBuffer: buffer,
                  filename: `${doc.type.replace(/[^a-z0-9]/gi, '_')}_${doc.date.replace(/\//g, '-')}.pdf`,
                };
              }
            }
          }
        } catch (e) {
          console.log('Iframe method failed');
        }

        // Method 4: Check for direct PDF link
        try {
          const pdfLinks = await downloadPage.$$('a[href$=".pdf"], a[href*="GetDocument"], a[href*="Download"]');
          for (const link of pdfLinks) {
            const href = await link.getAttribute('href');
            if (href) {
              console.log(`Trying direct link: ${href}`);
              const fullUrl = href.startsWith('http') ? href : `https://docuware7.illinois.gov${href}`;
              
              try {
                const response = await downloadPage.request.get(fullUrl);
                const buffer = await response.body();
                
                if (buffer.length > 1000 && buffer[0] === 0x25) {
                  await downloadPage.close();
                  console.log('Downloaded from direct link');
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
          }
        } catch (e) {
          console.log('Direct link method failed');
        }

        // Method 5: Use keyboard shortcut
        try {
          await downloadPage.keyboard.press('Control+s');
          await downloadPage.waitForTimeout(2000);
          
          const download = await downloadPage.waitForEvent('download', { timeout: 5000 }).catch(() => null);
          if (download) {
            const filePath = await download.path();
            if (filePath) {
              const fs = require('fs');
              const buffer = fs.readFileSync(filePath);
              await downloadPage.close();
              
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename(),
              };
            }
          }
        } catch (e) {
          console.log('Keyboard shortcut failed');
        }

        await downloadPage.close();
        console.log('All download methods failed');
        return null;

      } catch (error) {
        console.error(`Download page error: ${error}`);
        await downloadPage.close();
        return null;
      }

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
