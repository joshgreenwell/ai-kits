/**
 * Concrete personal-user destinations researched for USG-019 and rendered by USG-020.
 * Full primary-source notes, limitations, minimums, and verification context live in
 * docs/usage-evidence/usg-019-2026-09-15.md.
 */
export const ENVIRONMENTAL_ACTIONS = [
  {
    key: 'carbon-removal',
    category: 'Address estimated carbon',
    title: 'Climeworks Technology focus',
    href: 'https://climeworks.com/actnow',
    action: 'Explore carbon removal',
    purpose: 'Order a technology-based carbon-removal portfolio; the provider lists verification or certification under standards including Puro and Isometric.',
    unit: 'Metric tonnes of CO₂ removal ordered',
    availability: 'Self-service for individuals and organizations',
    geography: 'Portfolio suppliers and storage locations vary',
    delivery: 'Order confirmation is immediate; removal is delivered within seven years after the purchase year, followed by a delivery note.',
    evidence: 'An order is a paid commitment, not completed removal. Treat the delivery note—not the link click or order confirmation—as delivery evidence.',
    caveat: 'Prefer the technology-focused portfolio for the durable-removal action. Do not call an undelivered order a completed removal or claim neutrality.',
  },
  {
    key: 'water-stewardship',
    category: 'Support water stewardship',
    title: 'BEF Jordan River Water Restoration Certificates',
    href: 'https://store.b-e-f.org/household/',
    action: 'View household WRCs',
    purpose: 'Support restored and maintained flow in Utah’s Jordan River toward Farmington Bay of Great Salt Lake, a drought-affected catchment.',
    unit: '1 WRC = 1,000 gallons improved or restored',
    availability: 'One-time, annual, or gift purchase for households',
    geography: 'Jordan River / Great Salt Lake catchment, Utah, U.S.',
    delivery: 'BEF says WRC projects are third-party verified and registered; the purchase certificate names the project, volume, registry, and vintage.',
    evidence: 'The certificate documents catchment-specific water benefit. It does not carry verified greenhouse-gas benefit.',
    caveat: 'Because the inference datacenter and watershed are unknown, describe this as support for restoration—not reversal of the estimated direct-water use.',
  },
  {
    key: 'clean-electricity',
    category: 'Support cleaner electricity and efficiency',
    title: 'Rewiring America',
    href: 'https://donate.rewiringamerica.org/campaign/641970/donate',
    action: 'Support electrification work',
    purpose: 'Support U.S. tools, campaigns, partnerships, and community programs intended to make efficient electric home upgrades easier and more affordable.',
    unit: 'U.S. dollars contributed; no quantified energy unit',
    availability: 'Online donation; check, donor-advised-fund, and wire support are also described',
    geography: 'United States homes, businesses, communities, and electricity-system work',
    delivery: 'A successful donation produces a receipt, but the destination promises no donor-specific project, installation, electricity saving, or completion date.',
    evidence: 'This is a contribution to ongoing programs, not a purchase of electricity, renewable energy certificates, measured kWh savings, or carbon removal.',
    caveat: 'Organization-wide activity is not a donor-level outcome and does not show cleaner power for the unknown datacenter behind this estimate.',
  },
] as const;

export const ENVIRONMENTAL_ACTIONS_VERIFIED_AT = '2026-09-15';
