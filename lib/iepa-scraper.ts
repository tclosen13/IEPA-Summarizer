/**
 * IEPA Document Explorer Scraper v3
 * DocuWare double-click + viewer download
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
  private docuwareBaseUrl: string = '';

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

    // Fill search field
    const nameField = await this.page.$('#Name, input[name="Name"], input[type="text"]');
    if (nameField) {
      await nameField.fill(query.trim());
    } else {
      throw new Error('Could not find search field');
    }

    // Click search button
    const searchBtn = await this.page.$('button[type="submit"], input[type="submit"], .btn-primary');
    if (searchBtn) {
      await searchBtn.click();
    } else {
      await this.page.keyboard.press('Enter');
    }

    await this.page.waitForLoadState('networkidle');
    await this.page.waitForTimeout(3000);

    // Extract results
    const facilities = await this.page.evaluate(() => {
      const results: any[] = [];
      const rows = document.querySelectorAll('table tbody tr');
      
      rows.forEach((row, index) => {
        const link = row.querySelector('a[href*="Documents"]');
        if (link) {
          const href = link.getAttribute('href') || '';
          const cells = row.querySelectorAll('td');
          
          results.push({
            id: href.match(/\/(\d+)/)?.[1] || `facility-${index}`,
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
    if (!this.page) throw new Error('Browser not initialized');

    console.log(`Getting documents for facility: ${facilityId}`);

    const url = facilityId.startsWith('http') 
      ? facilityId 
      : `https://webapps.illinois.gov/EPA/DocumentExplorer/Documents/Index/${facilityId}`;
    
    await this.page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(2000);

    // Find DocuWare link and open it
    const docuwareLink = await this.page.$('a[href*="docuware" i]');
    if (!docuwareLink) {
      console.log('No DocuWare link found');
      return [];
    }

    const docuwareHref = await docuwareLink.getAttribute('href');
    if (!docuwareHref) return [];

    this.docuwareBaseUrl = docuwareHref;
    console.log(`Opening DocuWare: ${docuwareHref}`);

    // Open DocuWare in same page to maintain session
    await this.page.goto(docuwareHref, { waitUntil: 'networkidle', timeout: 60000 });
    await this.page.waitForTimeout(5000);

    // Extract documents from DocuWare grid
    const documents = await this.page.evaluate(() => {
      const docs: any[] = [];
      const rows = document.querySelectorAll('table tbody tr, [class*="result-row"], [class*="Row"]');
      
      rows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td, [class*="cell"], [class*="Cell"]');
        if (cells.length >= 3) {
          // Extract text from cells
          const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');
          
          // Find date (MM/DD/YYYY pattern)
          let date = '';
          for (const text of cellTexts) {
            const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
            if (dateMatch) {
              date = dateMatch[0];
