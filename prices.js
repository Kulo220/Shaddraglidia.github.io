// =====================================================================
// Prix des cartes (partagés entre les pages collection, wishlist et decks)
//
//  - Les prix viennent des API des jeux (Yu-Gi-Oh!, Magic, Pokémon) :
//      € = Cardmarket, $ = TCGplayer. Riftbound : pas de source gratuite.
//  - Ils sont enregistrés dans la table card_prices, PARTAGÉE : une carte
//    actualisée par un utilisateur profite à tous les autres.
//  - Une carte n'est actualisée que si son prix a plus de 24 h : à
//    l'ouverture d'une page, seules les cartes « périmées » sont redemandées.
//  - Ce sont des estimations de marché (moyennes / tendances), pas un prix
//    garanti : elles varient selon la langue, l'état et le foil de ta carte.
// =====================================================================

import { supabase } from './config.js';
import { getGame } from './games.js?v=19';

export const PRICE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 400; // cartes redemandées par jeu et par ouverture de page
const CURRENCY_KEY = 'tcg:currency';

export const CURRENCIES = {
  eur: { label: '€', source: 'Cardmarket' },
  usd: { label: '$', source: 'TCGplayer' },
};

const formats = {
  eur: new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }),
  usd: new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' }),
};

export function getCurrency() {
  try {
    return localStorage.getItem(CURRENCY_KEY) === 'usd' ? 'usd' : 'eur';
  } catch {
    return 'eur';
  }
}

function setCurrency(currency) {
  try {
    localStorage.setItem(CURRENCY_KEY, currency);
  } catch {
    /* le choix vaut pour cette page seulement */
  }
}

export const formatMoney = (amount, currency) => formats[currency].format(amount);

// Ce jeu sait-il donner des prix ? (Riftbound : non)
export const supportsPrices = (gameId) => Boolean(getGame(gameId)?.provider?.fetchPrices);

// prix d'une carte dans la devise choisie (ou null si inconnu)
export function unitPrice(entry, currency) {
  const value = entry?.[currency];
  return value == null ? null : Number(value);
}

// ---------- Boutons « Prix en € / $ » ----------

export function initCurrencyToggle(onChange) {
  const buttons = document.querySelectorAll('[data-currency-toggle]');
  const paint = () => {
    const current = getCurrency();
    const other = current === 'eur' ? 'usd' : 'eur';
    for (const button of buttons) {
      button.textContent = `Prix en ${CURRENCIES[current].label}`;
      const label = `Prix ${CURRENCIES[current].source} en ${CURRENCIES[current].label}. Cliquer pour afficher les prix ${CURRENCIES[other].source} en ${CURRENCIES[other].label}.`;
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  };
  for (const button of buttons) {
    button.addEventListener('click', () => {
      setCurrency(getCurrency() === 'eur' ? 'usd' : 'eur');
      paint();
      onChange?.(getCurrency());
    });
  }
  paint();
}

// ---------- Lecture et actualisation ----------

export async function loadPrices(cardIds) {
  const prices = new Map();
  const ids = [...new Set(cardIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from('card_prices')
      .select('card_id, eur, usd, updated_at')
      .in('card_id', ids.slice(i, i + 100));
    if (error) throw error;
    for (const row of data ?? []) prices.set(row.card_id, { eur: row.eur, usd: row.usd, updated_at: row.updated_at });
  }
  return prices;
}

const isStale = (entry) => !entry || Date.now() - new Date(entry.updated_at).getTime() > PRICE_TTL_MS;

// un jeu en échec (réseau, limite de requêtes) n'est pas réessayé en boucle
const failedGames = new Set();

// Redemande aux API les prix périmés (> 24 h) ou absents, puis les enregistre pour tous.
// Renvoie le nombre de cartes mises à jour. `prices` est complétée sur place.
export async function refreshPrices(cards, prices, { onProgress } = {}) {
  const groups = new Map();
  for (const card of cards) {
    if (!card.id || !supportsPrices(card.game) || failedGames.has(card.game) || !isStale(prices.get(card.id))) continue;
    if (!groups.has(card.game)) groups.set(card.game, new Map());
    groups.get(card.game).set(card.id, card); // sans doublon
  }

  let updated = 0;
  for (const [game, byId] of groups) {
    const batch = [...byId.values()].slice(0, MAX_PER_RUN);
    const provider = getGame(game).provider;
    onProgress?.(`Actualisation des prix ${provider.label} (${batch.length} carte${batch.length > 1 ? 's' : ''})…`);

    let found;
    try {
      found = await provider.fetchPrices(batch);
    } catch (err) {
      console.warn(`Prix ${provider.label} indisponibles pour le moment`, err);
      failedGames.add(game);
      continue;
    }

    const now = new Date().toISOString();
    const rows = [...found].map(([card_id, p]) => ({ card_id, eur: p.eur ?? null, usd: p.usd ?? null, updated_at: now }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from('card_prices').upsert(rows.slice(i, i + 200), { onConflict: 'card_id' });
      if (error) throw error;
    }
    for (const row of rows) prices.set(row.card_id, { eur: row.eur, usd: row.usd, updated_at: row.updated_at });
    updated += rows.length;
  }
  return updated;
}

// ---------- Totaux ----------

// items : [{ card, quantity }]. Ne compte que les jeux qui ont des prix.
export function sumPrices(items, prices, currency) {
  let total = 0;
  let unpriced = 0;
  for (const { card, quantity } of items) {
    if (!supportsPrices(card.game)) continue;
    const unit = unitPrice(prices.get(card.id), currency);
    if (unit == null) unpriced += 1;
    else total += unit * quantity;
  }
  return { total, unpriced };
}

// Date de la dernière actualisation parmi ces cartes (texte français) ou ''
export function latestUpdate(cards, prices) {
  let latest = 0;
  for (const card of cards) {
    const entry = prices.get(card.id);
    if (entry) latest = Math.max(latest, new Date(entry.updated_at).getTime());
  }
  return latest ? new Date(latest).toLocaleDateString('fr-FR') : '';
}
