/**
 * The help that is a country's own.
 *
 * Most of what Sudor says is the same everywhere: the body, the medicine and the weather do not change at a
 * border. What does change is who to ring, which list to be on, how to get medicine early, and who helps with a
 * bill. Those were American only (211, LIHEAP, Florida's registry), so somebody in Leeds or Perth heard a number
 * that does not work there. This is the one place that knows the difference, for the countries Alexa+ is sold or
 * in early access in, with one honest line for everywhere else.
 *
 * Every line here was checked against the scheme's own regulator or operator:
 *
 *   United States  211 for local help; LIHEAP for heating and cooling bills; Florida's county special needs
 *                  registries, closing to new sign-ups 72 hours before tropical storm winds; Texas's STEAR, by
 *                  211; Florida's law that insurers must allow early refills once a hurricane warning or a state
 *                  of emergency is declared (Fla. Stat. 252.358).
 *   Canada         211, free and confidential, in over 150 languages.
 *   United Kingdom The Priority Services Register, which Ofgem requires every supplier and network operator to
 *                  keep, free, for people who rely on powered medical equipment, over pensionable age, disabled,
 *                  chronically ill or with a child under five: advance notice of planned power cuts and priority
 *                  help in one. A pharmacist's emergency supply of most prescription medicines, up to 30 days,
 *                  without a prescription (Human Medicines Regulations 2012, regulation 225); never Schedule 1, 2
 *                  or 3 controlled drugs, so never methadone. The Warm Home Discount, 150 pounds off the bill for
 *                  households on qualifying means tested benefits, applied by the supplier.
 *   Australia      Life support registration with the electricity retailer or distributor, which under the
 *                  National Energy Retail Rules brings at least four business days' written notice of a planned
 *                  outage. Retailers must keep a hardship program for residential customers who cannot pay. Most
 *                  states let a pharmacist supply most medicines for three days without a prescription in an
 *                  emergency (the PBS factsheet on natural disasters).
 *
 * Alexa+ is in twelve countries as of October 2026: the US, Canada, Mexico, Brazil, the UK, Germany, Austria,
 * France, Italy, Spain, Australia and India. The other eight, each from its regulator or a government notice:
 *
 *   Canada         Ontario's winter disconnection ban, November 15 to April 30, and LEAP for arrears, both from the
 *                  Ontario Energy Board. In British Columbia's declared emergencies pharmacists may give an
 *                  emergency supply; scope differs by province, so the line says to ask.
 *   Mexico         Protección Civil opens temporary refuges in cold spells and some heat, and 911 directs people
 *                  to them (Chihuahua: 354 in one cold spell).
 *   Brazil         Defesa Civil on 199, free, nationwide since 2013, for floods, landslides and collapses. Free
 *                  SMS alerts: text the eight digit CEP to 40199. The Tarifa Social de Energia Elétrica, applied
 *                  from CadÚnico (up to half a minimum wage a person, or BPC), widened in 2025 to families on up to
 *                  three minimum wages with somebody who depends on essential electric equipment.
 *   Germany        A supplier may not cut a household off for arrears where, for reasons of health or age, there is
 *                  a concrete danger to life or limb (EnWG section 41f(2)), said to the supplier in writing. The
 *                  pharmacy emergency line, 22833 from a mobile, 0800 00 22833 from a landline. Kältehilfe and
 *                  Wärmestuben are the town's own.
 *   Austria        Apothekenruf 1455 says which pharmacy is on duty. 1450 is nurse advice, day and night.
 *   France         The mairie keeps a register of people over 65, or disabled, living at home, who are contacted in a
 *                  heatwave or another emergency (on request, free, confidential). Canicule Info Service, 0 800 06
 *                  66 66, free, 9 to 7, opened for each heatwave. The chèque énergie, sent automatically, 48 to 277
 *                  euros a year, for any energy bill including heating; asked for online until December 31.
 *   Italy          The Health Ministry's free line, 1500, in a heatwave: what the region and the comune have opened.
 *                  The bonus sociale is applied to the bill automatically under an ISEE of 9,796 euros (2026), once a
 *                  DSU is filed; a separate bonus for electromedical equipment is asked for, with no ISEE limit.
 *   Spain          The bono social eléctrico, 42.5 per cent off, 57.5 for the severely vulnerable, to the end of
 *                  2026, on the regulated PVPC tariff with a reference supplier; beneficiaries cannot be cut off
 *                  through 2026. Barcelona and others open refugios climáticos.
 *   India          Heat action plans, from the NDMA's 2016 guidelines on Ahmedabad's, open shaded places and cooling
 *                  centres at markets and bus stands. 112 and 108 are in world.ts.
 *
 * Sources:
 *   https://www.211.org/
 *   https://211ontario.ca/contact-211-ontario
 *   https://liheapch.ncat.org/node/1516
 *   https://nassau.floridahealth.gov/programs-and-services/emergency-preparedness-and-response/special-needs-shelter/
 *   https://tdem.texas.gov/response/state-of-texas-emergency-assistance-registry
 *   https://florida.public.law/statutes/fla._stat._252.358
 *   https://www.ofgem.gov.uk/consumers/household-gas-and-electricity-guide/extra-help-energy-services/priority-services-register-people-need
 *   https://norfolk.communitypharmacy.org.uk/commissioned-services/ccg-information/funded-emergency-supplies/
 *   https://www.gov.uk/government/publications/warm-home-discount-eligibility-statement-england-and-wales-2025-to-2026-scheme-year/warm-home-discount-eligibility-statement-england-and-wales-2025-to-2026
 *   https://www.aer.gov.au/retail-markets/compliance-reporting/aer-life-support-registration-guide-2021
 *   https://www.aemc.gov.au/news-centre/media-releases/better-hardship-programs-customers-who-need-help-paying-their-bills
 *   https://www.pbs.gov.au/publication/factsheets/pbs-arrangements-natural-disasters-and-emergencies
 *   https://community.amazondeveloper.com/t/sept-21-2026-alexa-in-india-aws-builder-app/29198
 *   https://oeb.ca/node/5400
 *   https://www.bcpharmacists.org/node/3335
 *   https://nortedigital.mx/habilitan-en-el-estado-354-refugios-para-enfrentar-bajas-temperaturas
 *   https://prefeitura.sp.gov.br/web/defesa_civil/w/noticias/184614
 *   https://teletime.com.br/14/09/2017/sms-com-alerta-de-desastre-natural-sera-ampliado-para-todo-o-pais/
 *   https://www.folhape.com.br/economia/tarifa-social-de-energia-veja-como-familias-com-cadastro/482584/
 *   https://www.gesetze-im-internet.de/enwg_2005/__41f.html
 *   https://www.berlin.de/ba-neukoelln/aktuelles/bezirksticker/angebote-der-kaeltehilfe-winter-2025-2026-in-neukoelln-1621927.php
 *   https://en.wikipedia.org/wiki/Healthcare_number_1450
 *   https://www.pressetext.com/news/apothekenruf-1455-begruesst-gesundheitstelefon-1450.html
 *   https://www.service-public.gouv.fr/particuliers/actualites/A14978?lang=fr
 *   https://www.santepubliquefrance.fr/sites/default/files/2026-06/bullreg_canicule_bfc_20260624.pdf
 *   https://www.info.gouv.fr/actualite/crise-energetique-envoi-anticipe-du-cheque-energie-2026
 *   https://www.salute.gov.it/new/it/tema/ondate-di-calore/numero-di-pubblica-utilita-1500-proteggiamoci-dal-caldo/
 *   https://www.arera.it/comunicati-stampa/dettaglio/bonus-sociali-arera-alza-a-9796-euro-la-soglia-isee-per-laccesso-alle-agevolazioni-per-acqua-luce-gas-e-rifiuti
 *   https://www.merca2.es/2026/05/27/cnmc-recalcula-bono-social-electrico-2026-2385118/
 *   https://www.miteco.gob.es/en/energia/pobreza-energetica/pe-001/que-es.html
 *   https://www.undrr.org/news/heatwaves-lessons-india-dealing-growing-hazard
 */

import { inUS } from './world.js';

const code = (country: string | null | undefined): string => (country ?? 'US').toUpperCase();

/** The number that knows where the warming and cooling centres are: 211 in the US and Canada, none elsewhere. */
export const helpLine = (country: string | null | undefined): string | null => (inUS(country) || code(country) === 'CA' ? '211' : null);

/** Who knows which warm and cool places are open, where there is no 211: a noun to put after "ring". */
export function whoKnows(country: string | null | undefined): string {
  switch (code(country)) {
    case 'FR': return 'your mairie';
    case 'DE': case 'AT': return 'your town hall';
    case 'IT': return 'your comune';
    case 'ES': return 'your ayuntamiento';
    case 'MX': return 'Protección Civil, on 911';
    case 'BR': return 'Defesa Civil, on 199';
    case 'IN': return 'your municipal corporation';
    default: return 'your local council';
  }
}

/** Where somebody without heat or cooling at home can go, said the way it is found there. */
export function warmPlace(country: string | null | undefined): string {
  if (inUS(country) || code(country) === 'CA') return 'a warming centre: call 211 to find one open now';
  switch (code(country)) {
    case 'GB': return 'a warm space: your council keeps a list of the libraries and halls open as one';
    case 'DE': case 'AT': return 'a Wärmestube or another warm room: your town hall or the local Kältehilfe knows which are open';
    case 'MX': return 'a temporary refuge: Protección Civil opens them in a cold spell, and 911 can tell you the nearest';
    case 'BR': return 'a shelter: Defesa Civil, on 199, knows which are open';
    default: return `a warm public building: ${whoKnows(country)} will know which are open`;
  }
}

export function coolPlace(country: string | null | undefined): string {
  if (inUS(country) || code(country) === 'CA') return 'a cooling centre: call 211 to find one open now';
  switch (code(country)) {
    case 'FR': return 'a cooled room: your mairie keeps the list, and in a heatwave Canicule Info Service, 0 800 06 66 66, free from 9 to 7, can help';
    case 'IT': return 'a cool public place: in a heatwave the Health Ministry\'s free line, 1500, says what your region and comune have opened';
    case 'ES': return 'a climate shelter, a cooled library or civic centre: your ayuntamiento keeps the list where it has them';
    case 'IN': return 'a cooling centre or shaded shelter: where your city has a heat action plan, they open at markets and bus stands';
    case 'MX': return 'a temporary refuge: Protección Civil opens some in the heat, and 911 can tell you the nearest';
    default: return `a cooled public building, like a library or a shopping centre: ${whoKnows(country)} will know which are open`;
  }
}

/**
 * The list to be on when power or getting out matters. `state` is only read in the United States, where the
 * registries are a state's or a county's own.
 */
export function registry(country: string | null | undefined, state: 'FL' | 'TX' | null, hurricane: boolean): string {
  if (inUS(country)) {
    if (state === 'FL') return `Florida counties keep a special needs registry for people who need help to leave or a shelter with power. Register with your county emergency management${hurricane ? ' now: new sign-ups close 72 hours before tropical storm winds arrive' : ''}.`;
    if (state === 'TX') return 'Texas keeps a registry for people who need help in an emergency, called STEAR. Register by calling 211: it does not promise a service, but it tells responders you are there.';
    return 'Ask your county emergency management whether it keeps a registry for people who need help to leave or need power. Many do, and responders use it.';
  }
  if (code(country) === 'GB') return 'Join the Priority Services Register with your energy supplier, free: you are told before a planned power cut and helped first in one. Your water company keeps one too.';
  if (code(country) === 'AU') return 'Register your life support equipment with your electricity retailer: by law you then get at least four business days’ notice of a planned outage.';
  if (code(country) === 'FR') return 'Ask your mairie to put you on its register of vulnerable people living at home: in a heatwave or another emergency, they are the ones contacted. It is free and confidential.';
  if (code(country) === 'BR') return 'Text your eight digit CEP to 40199 for free Defesa Civil warnings by SMS, and ring Defesa Civil on 199 if you need help to leave.';
  return 'Ask your electricity company whether it keeps a list of customers who rely on power for medical equipment, and ask your local council about help to leave.';
}

/**
 * Getting medicine early, before a disaster closes the pharmacy. `controlled` is a Schedule 2 or 3 drug such as
 * methadone, which the UK's emergency supply never covers.
 */
export function earlySupply(country: string | null | undefined, state: 'FL' | 'TX' | null, hurricane: boolean, controlled = false): string {
  if (inUS(country) && state === 'FL' && hurricane) return 'In Florida, once a hurricane warning or a state of emergency is declared, insurers must allow early refills, so get a 30 day supply now.';
  if (code(country) === 'GB' && !controlled) return 'If you run short, a pharmacist can give an emergency supply of most prescription medicines, up to 30 days, without a new prescription.';
  if (code(country) === 'AU' && !controlled) return 'If you run short, in most states a pharmacist can supply most medicines for three days without a prescription in an emergency, so ask yours now.';
  if (code(country) === 'CA') return 'Ask your pharmacist about an early refill now. In a declared emergency many provinces let pharmacists give an emergency supply.';
  if (code(country) === 'DE') return 'Ask your pharmacy about an early supply now. If it is closed, the pharmacy emergency line, 22833 from a mobile, finds the one on duty.';
  if (code(country) === 'AT') return 'Ask your pharmacy about an early supply now. If it is closed, Apothekenruf, 1455, says which pharmacy is on duty.';
  return 'Ask your pharmacist about an early refill now, before the pharmacy closes.';
}

/** Help with an energy bill, where it was checked; nothing anywhere else. */
export function billHelp(country: string | null | undefined, use: 'heating' | 'cooling'): string {
  if (inUS(country)) {
    return use === 'heating'
      ? ' If it is the bill, LIHEAP helps pay for heating: call 1 866 674 6327 to find your local office. Many states do not let the utility cut off heat in winter or freezing weather, and a note from your doctor can hold off a shutoff, so ring the utility before you go without.'
      : ' If it is the bill, LIHEAP can help pay for cooling: call 1 866 674 6327 to find your local office. About 19 states and Washington DC do not allow the power to be shut off in extreme heat, and almost every state protects someone whose doctor says they need power for their health, so ask your utility before you go without.';
  }
  if (code(country) === 'GB') return ' If it is the bill, ask your supplier about the Warm Home Discount, 150 pounds off for households on some benefits, and get on its Priority Services Register.';
  if (code(country) === 'AU') return ' If it is the bill, ask your energy retailer for its hardship program: every retailer has to offer one, with payment plans and help with concessions.';
  switch (code(country)) {
    case 'CA': return ' If it is the bill, ask your utility for a payment plan. In Ontario, LEAP helps pay arrears, and the power cannot be cut off for not paying from November 15 to April 30.';
    case 'FR': return ' If it is the bill, the chèque énergie, sent automatically, pays 48 to 277 euros a year towards any energy bill, heating included. If yours did not come, ask for it online before December 31.';
    case 'IT': return ' If it is the bill, the bonus sociale comes off it automatically with an ISEE under 9,796 euros, once you file the DSU. Somebody who uses electromedical equipment can ask for a separate bonus, whatever the income.';
    case 'ES': return ' If it is the bill, the bono social eléctrico takes 42.5 per cent off, 57.5 if you are severely vulnerable, to the end of 2026, on the regulated PVPC tariff with a reference supplier, and those who get it cannot be cut off this year.';
    case 'DE': return ' If it is the bill, a supplier may not cut you off where your health or age puts your life in real danger without power. Tell the supplier that in writing, and the Verbraucherzentrale can help.';
    case 'BR': return ' If it is the bill, the Tarifa Social de Energia Elétrica gives a discount to families in CadÚnico, and since 2025 to families on up to three minimum wages with somebody who depends on electric medical equipment. The CadÚnico holder has to be the name on the bill; ask at your CRAS.';
    default: return '';
  }
}
