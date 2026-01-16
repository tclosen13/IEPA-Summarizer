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

  async searchFacilities(query: string): Promise<FacilityResult[]> {
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Searching for facilities: "${query}"`);

    // Navigate to the attribute search page
    await this.page.goto('https://webapps.illinois.gov/EPA/DocumentExplorer/Attributes', {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    // Wait for page to fully load
    await this.page.waitForTimeout(3000);

    // Take screenshot for debugging
    console.log('Page loaded, looking for search form...');

    // Try to find and fill the Name field using various selectors
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
      // Try filling any visible text input
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

    // Find and click the search button
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
      // Try pressing Enter instead
      await this.page.keyboard.press('Enter');
      console.log('Pressed Enter to submit');
    }

    // Wait for results to load
    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(3000);

    // Extract facility results
    const facilities = await this.page.evaluate(() => {
      const results: any[] = [];
      
      // Try multiple selectors for result rows
      const selectors = [
        'table tbody tr',
        '.search-results tr',
        '.facility-item',
        '[data-facility-id]',
        'a[href*="/Facility/"]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el, index) => {
            // Try to find facility link
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

    // Navigate to facility page
    const url = facilityId.startsWith('http') 
      ? facilityId 
      : `https://webapps.illinois.gov/EPA/DocumentExplorer/Documents/Index/${facilityId}`;
    
    await this.page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    await this.page.waitForTimeout(3000);

    // Try to expand all document sections
    const expandButtons = await this.page.$$('button, a, [data-toggle], .expand, .collapse-toggle');
    for (const button of expandButtons.slice(0, 10)) {
      try {
        const text = await button.textContent();
        if (text && (text.includes('expand') || text.includes('show') || text.includes('+'))) {
          await button.click();
          await this.page.waitForTimeout(500);
        }
      } catch (e) {
        continue;
      }
    }

    await this.page.waitForTimeout(2000);

    // Extract document information
    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      
      // Look for document links
      const linkSelectors = [
        'a[href*="DocuWare"]',
        'a[href*=".pdf"]',
        'a[href*="Document"]',
        'a[href*="ViewDocument"]',
        '.document-link',
        'table a'
      ];

      const seenUrls = new Set();

      for (const selector of linkSelectors) {
        const links = document.querySelectorAll(selector);
        links.forEach((link, index) => {
          const href = link.getAttribute('href') || '';
          if (seenUrls.has(href)) return;
          seenUrls.add(href);

          const row = link.closest('tr') || link.closest('div') || link.parentElement;
          const cells = row?.querySelectorAll('td') || [];
          
          let type = link.textContent?.trim() || 'Document';
          let date = '';
          let category = '';
          let description = type;

          // Try to extract info from table cells
          if (cells.length >= 1) type = cells[0]?.textContent?.trim() || type;
          if (cells.length >= 2) {
            const cell2 = cells[1]?.textContent?.trim() || '';
            if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(cell2)) {
              date = cell2;
            } else {
              category = cell2;
            }
          }
          if (cells.length >= 3) {
            const cell3 = cells[2]?.textContent?.trim() || '';
            if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(cell3)) {
              date = cell3;
            }
          }

          // Look for date patterns in nearby text
          if (!date) {
            const rowText = row?.textContent || '';
            const dateMatch = rowText.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
            if (dateMatch) date = dateMatch[0];
          }

          if (href) {
            docs.push({
