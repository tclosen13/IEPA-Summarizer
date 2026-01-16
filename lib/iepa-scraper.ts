/**
 * IEPA Document Explorer Scraper
 * Uses Playwright to automate searching and downloading documents
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

  /**
   * Initialize the browser
   */
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
      ],
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    this.page = await this.context.newPage();
    this.isInitialized = true;
    console.log('Browser initialized');
  }

  /**
   * Search for facilities by name, address, city, zip, or county
   */
  async searchFacilities(query: string): Promise<FacilityResult[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Searching for facilities: "${query}"`);

    // Navigate to the attribute search page
    await this.page.goto('https://webapps.illinois.gov/EPA/DocumentExplorer/Attributes', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for the search form to load
    await this.page.waitForSelector('input[name="Name"], #Name', { timeout: 15000 });

    // Try to determine what type of query this is
    const isNumeric = /^\d+$/.test(query.trim());
    const isZip = /^\d{5}$/.test(query.trim());

    if (isZip) {
      // Search by ZIP
      await this.page.fill('input[name="Zip"], #Zip', query.trim());
    } else if (isNumeric) {
      // Likely a Bureau ID or IEPA ID
      await this.page.fill('input[name="IepaId"], #IepaId', query.trim());
    } else {
      // Search by name (most common)
      await this.page.fill('input[name="Name"], #Name', query.trim());
    }

    // Submit the search
    await this.page.click('button[type="submit"], input[type="submit"]');

    // Wait for results to load
    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(2000); // Extra wait for dynamic content

    // Extract facility results
    const facilities = await this.page.evaluate(() => {
      const results: FacilityResult[] = [];
      
      // Look for facility links in the results
      const facilityLinks = document.querySelectorAll('a[href*="/EPA/DocumentExplorer/Facility/"]');
      
      facilityLinks.forEach((link) => {
        const href = link.getAttribute('href') || '';
        const idMatch = href.match(/\/Facility\/(\d+)/);
        
        if (idMatch) {
          const row = link.closest('tr') || link.closest('.facility-item') || link.parentElement;
          const cells = row?.querySelectorAll('td');
          
          let name = link.textContent?.trim() || '';
          let address = '';
          let city = '';
          let county = '';
          let zip = '';
          let programs: string[] = [];

          if (cells && cells.length >= 4) {
            name = cells[0]?.textContent?.trim() || name;
            address = cells[1]?.textContent?.trim() || '';
            city = cells[2]?.textContent?.trim() || '';
            county = cells[3]?.textContent?.trim() || '';
            if (cells[4]) zip = cells[4]?.textContent?.trim() || '';
          }

          // Look for program badges
          const badges = row?.querySelectorAll('.badge, .program, [class*="program"]');
          badges?.forEach(b => {
            const text = b.textContent?.trim();
            if (text) programs.push(text);
          });

          results.push({
            id: idMatch[1],
            name,
            address,
            city,
            county,
            zip,
            programs,
            link: href,
          });
        }
      });

      return results;
    });

    console.log(`Found ${facilities.length} facilities`);
    return facilities;
  }

  /**
   * Get all documents for a facility
   */
  async getFacilityDocuments(facilityId: string): Promise<DocumentInfo[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Getting documents for facility: ${facilityId}`);

    // Navigate to facility page
    await this.page.goto(`https://webapps.illinois.gov/EPA/DocumentExplorer/Facility/${facilityId}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for page to load
    await this.page.waitForTimeout(2000);

    // Look for and click "Imaged Documents" or similar expandable sections
    const expandButtons = await this.page.$$('button:has-text("Imaged"), a:has-text("Imaged"), [data-toggle]:has-text("Document")');
    for (const button of expandButtons) {
      try {
        await button.click();
        await this.page.waitForTimeout(1000);
      } catch {
        // Button may not be clickable
      }
    }

    // Also try clicking any accordion/collapsible elements
    const accordions = await this.page.$$('.accordion-header, .collapse-toggle, [data-bs-toggle="collapse"]');
    for (const acc of accordions) {
      try {
        await acc.click();
        await this.page.waitForTimeout(500);
      } catch {
        // May not be clickable
      }
    }

    await this.page.waitForTimeout(2000);

    // Extract document information
    const documents = await this.page.evaluate(() => {
      const docs: DocumentInfo[] = [];
      
      // Look for document links - they typically link to DocuWare or have PDF in the URL
      const docLinks = document.querySelectorAll('a[href*="DocuWare"], a[href*=".pdf"], a[href*="Document"], table a');
      
      docLinks.forEach((link, index) => {
        const href = link.getAttribute('href') || '';
        const row = link.closest('tr');
        const cells = row?.querySelectorAll('td');
        
        let type = '';
        let date = '';
        let description = link.textContent?.trim() || '';
        let category = '';

        if (cells && cells.length >= 2) {
          // Try to extract from table cells
          const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');
          
          // Look for date pattern (MM/DD/YYYY)
          cellTexts.forEach(text => {
            if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(text)) {
              date = text;
            }
          });
          
          type = cellTexts[0] || '';
          if (cellTexts.length > 2) {
            category = cellTexts[1] || '';
          }
        }

        // Only add if it looks like a document link
        if (href && (href.includes('DocuWare') || href.includes('.pdf') || href.includes('Document'))) {
          docs.push({
            id: `doc-${index}`,
            type: type || 'Unknown',
            date: date || 'Unknown',
            category: category || 'Imaged Document',
            description: description || 'Document',
            viewerUrl: href.startsWith('http') ? href : `https://webapps.illinois.gov${href}`,
          });
        }
      });

      return docs;
    });

    console.log(`Found ${documents.length} documents`);
    return documents;
  }

  /**
   * Download a document PDF
   */
  async downloadDocument(doc: DocumentInfo): Promise<DownloadedDocument | null> {
    if (!this.page || !this.context) throw new Error('Browser not initialized');

    console.log(`Downloading document: ${doc.description} (${doc.date})`);

    try {
      // Navigate to the document viewer URL
      if (!doc.viewerUrl) {
        console.log('No viewer URL for document');
        return null;
      }

      // Create a new page for downloading to avoid disrupting main navigation
      const downloadPage = await this.context.newPage();
      
      try {
        // Set up download handling
        const downloadPromise = downloadPage.waitForEvent('download', { timeout: 30000 }).catch(() => null);
        
        // Navigate to document
        await downloadPage.goto(doc.viewerUrl, {
          waitUntil: 'networkidle',
          timeout: 30000,
        });

        // Wait a moment for any redirects
        await downloadPage.waitForTimeout(2000);

        // Check if we're on a DocuWare viewer page
        const currentUrl = downloadPage.url();
        
        if (currentUrl.includes('DocuWare')) {
          // Look for download button or PDF link
          const downloadBtn = await downloadPage.$('a[href*=".pdf"], button:has-text("Download"), a:has-text("Download"), [class*="download"]');
          
          if (downloadBtn) {
            const newDownloadPromise = downloadPage.waitForEvent('download', { timeout: 30000 }).catch(() => null);
            await downloadBtn.click();
            
            const download = await newDownloadPromise;
            if (download) {
              const buffer = await download.path().then(p => {
                const fs = require('fs');
                return fs.readFileSync(p);
              });
              
              await downloadPage.close();
              
              return {
                ...doc,
                pdfBuffer: buffer,
                filename: download.suggestedFilename(),
              };
            }
          }

          // Try to find iframe with PDF
          const pdfFrame = downloadPage.frameLocator('iframe[src*=".pdf"], iframe[src*="DocuWare"]');
          const frameSrc = await downloadPage.$eval('iframe', (el) => el.src).catch(() => null);
          
          if (frameSrc && frameSrc.includes('.pdf')) {
            const response = await downloadPage.request.get(frameSrc);
            const buffer = await response.body();
            
            await downloadPage.close();
            
            return {
              ...doc,
              pdfBuffer: buffer,
              filename: `${doc.type}_${doc.date.replace(/\//g, '-')}.pdf`,
            };
          }
        }

        // Direct PDF URL
        if (currentUrl.endsWith('.pdf') || currentUrl.includes('.pdf')) {
          const response = await downloadPage.request.get(currentUrl);
          const buffer = await response.body();
          
          await downloadPage.close();
          
          return {
            ...doc,
            pdfBuffer: buffer,
            filename: `${doc.type}_${doc.date.replace(/\//g, '-')}.pdf`,
          };
        }

        // Check if a download was triggered
        const download = await downloadPromise;
        if (download) {
          const buffer = await download.path().then(p => {
            const fs = require('fs');
            return fs.readFileSync(p);
          });
          
          await downloadPage.close();
          
          return {
            ...doc,
            pdfBuffer: buffer,
            filename: download.suggestedFilename(),
          };
        }

        console.log(`Could not download document from: ${currentUrl}`);
        await downloadPage.close();
        return null;

      } catch (error) {
        console.error(`Error downloading document: ${error}`);
        await downloadPage.close();
        return null;
      }

    } catch (error) {
      console.error(`Download error for ${doc.description}:`, error);
      return null;
    }
  }

  /**
   * Close the browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isInitialized = false;
      console.log('Browser closed');
    }
  }
}

// Singleton instance for reuse
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
