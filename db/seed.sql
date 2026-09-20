-- Demo reference data. Fixed UUIDs so the frontend can hardcode a site and
-- inspector for the MVP (auth is a documented non-goal — see README).
INSERT INTO sites (id, code, name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'PLANT-A', 'Sangrur Biomass Plant A')
ON CONFLICT DO NOTHING;

INSERT INTO inspectors (id, site_id, name, employee_code) VALUES
  ('33333333-3333-3333-3333-333333333333',
   '11111111-1111-1111-1111-111111111111', 'R. Kumar', 'EMP-009')
ON CONFLICT DO NOTHING;

INSERT INTO suppliers (id, code, name, biomass_types) VALUES
  ('22222222-2222-2222-2222-222222222222', 'SUP-01', 'Green Biomass Ltd',      '{rice_husk,bagasse}'),
  ('22222222-2222-2222-2222-222222222223', 'SUP-02', 'Punjab Agro Residues',   '{paddy_straw}'),
  ('22222222-2222-2222-2222-222222222224', 'SUP-03', 'Doaba Wood Chips Co',    '{wood_chips}')
ON CONFLICT DO NOTHING;
