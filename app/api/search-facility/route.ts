// app/api/search-facility/route.ts
// Search for facilities in IEPA Document Explorer

import { NextRequest, NextResponse } from 'next/server';
import { getScraper, closeScraper } from '@/lib/iepa-scraper';

export const maxDuration = 60; // Allow up to 60 seconds for search

export async function POST(request: NextRequest) {
  try {
    const { query } = await request.json();

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return NextResponse.json(
        { error: 'Search query must be at least 2 characters' },
        { status: 400 }
      );
    }

    console.log(`Searching for: ${query}`);

    const scraper = await getScraper();
    const facilities = await scraper.searchFacilities(query.trim());

    return NextResponse.json({
      success: true,
      query: query.trim(),
      count: facilities.length,
      facilities,
    });

  } catch (error: any) {
    console.error('Search error:', error);
    
    // Try to close and reset scraper on error
    await closeScraper();

    return NextResponse.json(
      { 
        error: 'Search failed',
        message: error.message,
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/search-facility',
    method: 'POST',
    body: { query: 'Facility name, address, city, zip, or IEPA ID' },
  });
}
