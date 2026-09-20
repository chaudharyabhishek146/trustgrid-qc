import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

/** GET /api/v1/suppliers — populates the capture form's dropdown. */
export async function GET() {
  const suppliers = await query(
    `SELECT id, code, name, biomass_types FROM suppliers WHERE active ORDER BY code`,
  );
  return NextResponse.json({ suppliers });
}
