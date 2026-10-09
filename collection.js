// =====================================================================
// Moteur commun aux pages « collection » et « wishlist »
// (chaque page indique son rôle avec <body data-page="...">)
//  1. on choisit un jeu (sur la wishlist : ou « Tous les jeux »)
//  2. onglet « Ma collection / Ma wishlist » : tes cartes (filtrables)
//  3. onglet « Ajouter des cartes » : recherche via l'API du jeu
//  4. wishlist seulement : « Toutes les wishlists » (lecture seule)
//  5. collection seulement : « Collections des autres » (ceux qui la partagent)
//  6. wishlist : « Proposer » une carte que tu possèdes à quelqu'un qui la cherche (don ou vente)
// =====================================================================

import { supabase } from './config.js';
import { GAMES, getGame } from './games.js?v=19';
import {
  $, el, normalize, plural, keyOf, providerOf, friendlyError, fetchAll, ensureCard, createImages,
  bootPage, revealPage, ALL_FILES, SHOW_IMAGES, CARD_COLUMNS,
} from './common.js?v=19';
import {
  getCurrency, initCurrencyToggle, formatMoney, supportsPrices, unitPrice, loadPrices, refreshPrices, sumPrices,
  latestUpdate, CURRENCIES,
} from './prices.js?v=19';
import { createOffer, loadSentOffers } from './offers.js?v=19';
import { rulesFor } from './deck-rules.js?v=19';

// Numéro de version : sert à détecter des fichiers mélangés (anciens/nouveaux)
const APP_VERSION = '19';

// ---------- Rôle de la page ----------

const PAGE = document.body.dataset.page === 'wishlist' ? 'wishlist' : 'collection';

const PAGES = {
  collection: {
    table: 'collection_items',
    allGames: false, // un seul jeu à la fois
    community: false,
    others: true, // collections partagées par les autres utilisateurs
    notes: false,
    purchase: true, // suivi achat/prix payé
    savedKey: 'tcg:game',
    copy: ['exemplaire', 'exemplaires'],
    text: {
      loading: 'Chargement de ta collection…',
      empty: "Ta collection est vide pour l'instant. Va dans « Ajouter des cartes » pour commencer.",
      noMatch: 'Aucune carte de ta collection ne correspond.',
      badge: 'Possédée',
      add: 'Ajouter',
      confirmRemove: 'Retirer cette carte de ta collection ?',
      minus: 'Retirer un exemplaire',
      plus: 'Ajouter un exemplaire',
      valueLabel: 'valeur estimée',
    },
  },
  wishlist: {
    table: 'wishlist_items',
    allGames: true, // « Tous les jeux » possible
    community: true,
    others: false,
    notes: true,
    purchase: false,
    savedKey: 'tcg:wish:game',
    copy: ['exemplaire souhaité', 'exemplaires souhaités'],
    text: {
      loading: 'Chargement de ta wishlist…',
      empty: "Ta wishlist est vide pour l'instant. Va dans « Ajouter des cartes » pour commencer.",
      noMatch: 'Aucune carte de ta wishlist ne correspond.',
      badge: 'Dans ta wishlist',
      add: 'Ajouter à la wishlist',
      confirmRemove: 'Retirer cette carte de ta wishlist ?',
      minus: 'Souhaiter un exemplaire de moins',
      plus: 'Souhaiter un exemplaire de plus',
      valueLabel: 'coût estimé',
    },
  },
};
const CFG = PAGES[PAGE];

const ui = {
  games: $('games'),
  hint: $('hint'),
  workspace: $('workspace'),
  tabMine: $('tab-mine'),
  tabAdd: $('tab-add'),
  tabCommunity: $('tab-community'), // wishlist seulement
  tabOthers: $('tab-others'), // collection seulement
  share: $('share-collection'), // collection : interrupteur de partage
  shareMsg: $('share-msg'),
  priceNote: $('price-note'),
  purchaseSummary: $('purchase-summary'),
  count: $('count'),
  form: $('search-form'),
  mode: $('mode'),
  text: $('text'),
  textLabel: $('text-label'),
  type: $('type'),
  user: $('user'), // wishlist : filtre par utilisateur
  searchBtn: $('search-btn'),
  status: $('status'),
  list: $('results'),
  more: $('more'),
  lightbox: $('lightbox'),
  lightboxImg: $('lightbox-img'),
  lightboxName: $('lightbox-name'),
  lightboxMeta: $('lightbox-meta'),
};

const images = createImages({
  lightbox: ui.lightbox,
  img: ui.lightboxImg,
  name: ui.lightboxName,
  meta: ui.lightboxMeta,
  onError: (message) => setStatus(message, true),
});
const thumbnail = images.thumbnail;

const state = {
  userId: null,
  chosen: false, // un jeu (ou « Tous les jeux ») a été choisi
  game: null, // jeu choisi ; null + chosen = « Tous les jeux » (wishlist)
  tab: 'mine', // 'mine' | 'add' | 'community' | 'others'
  owned: new Map(), // clé de carte -> { itemId, quantity, note, card }
  community: { entries: [], owned: new Map(), similar: new Map() }, // toutes les wishlists
  others: { sharers: [], entries: [], wanted: new Map() }, // collections partagées par les autres
  offers: { sent: new Map(), available: true }, // tes offres envoyées (« userId:cardId » -> offre)
  prices: new Map(), // id de carte -> { eur, usd, updated_at } (table partagée card_prices)
  currency: getCurrency(), // 'eur' (Cardmarket) ou 'usd' (TCGplayer)
  pricesReady: false, // les prix de la liste affichée sont chargés (et actualisés si besoin)
  priceCards: [], // cartes de la liste affichée, pour le message sur les prix
  results: [], // résultats de l'API (onglet « Ajouter »)
  search: freshSearch(),
  forms: freshForms(),
  token: 0, // ignore les réponses d'une recherche périmée
};

function freshSearch() {
  return { offset: 0, lang: null, hasMore: false, total: 0, done: false, query: null };
}
function freshForms() {
  return {
    mine: { mode: 'name', text: '', type: '' },
    add: { mode: 'name', text: '', type: '' },
    community: { mode: 'name', text: '', type: '' },
    others: { mode: 'name', text: '', type: '' },
  };
}


// ---------- Petits utilitaires ----------

const pluralCopy = (n) => `${n} ${CFG.copy[n > 1 ? 1 : 0]}`;

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('is-error', isError);
}

function readSavedGame() {
  try {
    return localStorage.getItem(CFG.savedKey);
  } catch {
    return null;
  }
}
function saveGame(id) {
  try {
    localStorage.setItem(CFG.savedKey, id);
  } catch {
    /* stockage indisponible : pas grave */
  }
}

// ---------- Choix du jeu ----------

function renderGames() {
  ui.games.replaceChildren();

  if (CFG.allGames) {
    const all = el('button', 'chip', 'Tous les jeux');
    all.type = 'button';
    all.setAttribute('aria-pressed', String(state.chosen && !state.game));
    all.addEventListener('click', () => selectGame('all'));
    ui.games.append(all);
  }

  for (const game of GAMES) {
    const chip = el('button', 'chip', game.label);
    chip.type = 'button';
    if (game.provider) {
      chip.setAttribute('aria-pressed', String(state.game?.id === game.id));
      chip.addEventListener('click', () => selectGame(game.id));
    } else {
      chip.disabled = true;
      chip.append(el('small', null, 'bientôt'));
    }
    ui.games.append(chip);
  }
}

// Le sélecteur de type et le mode « code » n'existent que pour un jeu précis
function toggleGameFields() {
  const hasGame = Boolean(state.game);
  ui.mode.closest('.field').hidden = !hasGame;
  ui.type.closest('.field').hidden = !hasGame;
}

async function selectGame(id) {
  const all = id === 'all' && CFG.allGames;
  const game = all ? null : getGame(id);
  if (!all && !game) return;
  if (state.chosen && game === state.game) return;

  state.chosen = true;
  state.game = game;
  state.results = [];
  state.search = freshSearch();
  state.forms = freshForms();
  state.owned = new Map();
  state.community = { entries: [], owned: new Map(), similar: new Map() };
  state.others = { ...state.others, entries: [], wanted: new Map() };
  saveGame(id);

  renderGames();
  ui.hint.hidden = true;
  ui.workspace.hidden = false;
  toggleGameFields();

  if (game) {
    // Menu des types propre au jeu
    const ready = game.provider.init?.(); // peut renvoyer une promesse (ex. Pokémon)
    fillTypeSelect();
    if (ready?.then) {
      ready
        .then(() => {
          if (state.game === game) fillTypeSelect();
        })
        .catch((err) => console.warn('Initialisation du jeu :', err));
    }
    ui.mode.options[1].textContent = game.provider.idLabel;
  }

  // on reste sur « Toutes les wishlists » si on y était ; sinon retour à la liste
  if (state.tab !== 'community' && state.tab !== 'others') state.tab = 'mine';
  loadFormValues();
  updateTabs();

  setStatus(CFG.text.loading);
  ui.list.replaceChildren();
  try {
    await loadOwned();
    if (state.tab === 'community') await loadCommunity();
    if (state.tab === 'others') await loadOthers();
  } catch (err) {
    console.error(err);
    setStatus(friendlyError(err), true);
    return;
  }
  renderList();
  ensurePrices();
}

// ---------- Prix ----------

const gameLabel = (id) => GAMES.find((g) => g.id === id)?.label ?? id;

function setPriceNote(message, isError = false) {
  if (!ui.priceNote) return;
  ui.priceNote.textContent = message;
  ui.priceNote.classList.toggle('is-error', isError);
}

// « Prix Cardmarket (€) · mis à jour le 21/09/2026 · Pas de prix pour Riftbound »
function priceInfo(cards) {
  const supported = cards.filter((c) => supportsPrices(c.game));
  const without = [...new Set(cards.filter((c) => !supportsPrices(c.game)).map((c) => gameLabel(c.game)))];
  const parts = [];
  if (supported.length) {
    const date = latestUpdate(supported, state.prices);
    const { source, label } = CURRENCIES[state.currency];
    parts.push(`Prix ${source} (${label})${date ? ` · mis à jour le ${date}` : ''}`);
  }
  if (without.length) parts.push(`Pas de prix pour ${without.join(', ')}`);
  return parts.join(' · ');
}

// « Payé (€) : 12,50 € pour 5 cartes · valeur actuelle ≈ 14,00 € · soit +1,50 € de plus-value potentielle »
// Regroupe par devise d'achat ; une carte sans prix du marché connu est comptée à part.
function renderPurchaseSummary(shown) {
  if (!ui.purchaseSummary || !CFG.purchase) return;

  if (state.tab !== 'mine' || !shown.length) {
    ui.purchaseSummary.hidden = true;
    return;
  }

  const groups = new Map(); // devise -> { paid, pricedPaid, market, count, unpriced }
  for (const entry of shown) {
    if (!entry.purchased || entry.purchasePrice == null) continue;
    const cur = entry.purchaseCurrency;
    const g = groups.get(cur) ?? { paid: 0, pricedPaid: 0, market: 0, count: 0, unpriced: 0 };
    g.paid += entry.purchasePrice * entry.quantity;
    g.count += entry.quantity;
    const unit = unitPrice(state.prices.get(entry.card.id), cur);
    if (unit == null) g.unpriced += entry.quantity;
    else {
      g.pricedPaid += entry.purchasePrice * entry.quantity;
      g.market += unit * entry.quantity;
    }
    groups.set(cur, g);
  }

  if (!groups.size) {
    ui.purchaseSummary.hidden = true;
    return;
  }

  const lines = [];
  for (const [cur, g] of groups) {
    const money = (v) => formatMoney(v, cur);
    let line = `Payé (${CURRENCIES[cur].label}) : ${money(g.paid)} pour ${plural(g.count, 'exemplaire')}`;
    if (!state.pricesReady) {
      line += ' · comparaison en attente des prix…';
    } else if (g.market || g.pricedPaid) {
      const diff = g.market - g.pricedPaid;
      const rounded = Math.abs(diff) < 0.01;
      line += ` · valeur actuelle ≈ ${money(g.market)}`;
      line += rounded
        ? ' (proche du prix payé)'
        : diff > 0
          ? ` · soit +${money(diff)} de plus-value potentielle`
          : ` · soit −${money(Math.abs(diff))} de moins-value potentielle`;
      if (g.unpriced) line += ` (${plural(g.unpriced, 'exemplaire')} sans prix du marché)`;
    } else {
      line += ' · prix du marché inconnu pour ces cartes';
    }
    lines.push(line);
  }

  ui.purchaseSummary.hidden = false;
  ui.purchaseSummary.textContent = lines.join(' · ');
}

// Cartes dont on affiche le prix, selon l'onglet
function cardsOfCurrentTab() {
  if (state.tab === 'community') return state.community.entries.map((e) => e.card);
  if (state.tab === 'others') return state.others.entries.map((e) => e.card);
  return [...state.owned.values()].map((e) => e.card);
}

let priceRun = 0;

// Charge les prix déjà connus (base partagée), puis redemande aux API ceux de plus de 24 h.
// Ne bloque jamais l'affichage : les prix apparaissent dès qu'ils arrivent.
async function ensurePrices(cards = cardsOfCurrentTab()) {
  const run = ++priceRun;
  state.priceCards = cards;
  state.pricesReady = false;
  if (!cards.length) {
    setPriceNote('');
    return;
  }
  const priced = cards.filter((c) => c.id && supportsPrices(c.game));
  if (!priced.length) {
    state.pricesReady = true;
    setPriceNote(priceInfo(cards));
    return;
  }

  try {
    const known = await loadPrices(priced.map((c) => c.id));
    for (const [id, entry] of known) state.prices.set(id, entry);
    if (run !== priceRun) return;
    refreshPriceUi();

    const updated = await refreshPrices(priced, state.prices, {
      onProgress: (message) => run === priceRun && setPriceNote(message),
    });
    if (run !== priceRun) return;
    state.pricesReady = true;
    if (updated) refreshPriceUi();
    setPriceNote(priceInfo(cards));
    if (!updated) refreshPriceUi(); // pour afficher « (n sans prix) » une fois tout chargé
  } catch (err) {
    console.error(err);
    if (run === priceRun) setPriceNote(friendlyError(err), true);
  }
}

// Réaffiche la liste avec les prix (sans casser une note en cours de saisie)
function refreshPriceUi() {
  // onglet « Ajouter » : pas de prix affichés, et on ne touche pas au focus des boutons
  // note en cours de saisie : on ne reconstruit pas la liste
  const activeClasses = document.activeElement?.classList;
  if (state.tab === 'add' || activeClasses?.contains('note-input') || activeClasses?.contains('purchase-price')) {
    updateMineStatus();
    return;
  }
  renderList();
}

// « ≈ 4,20 € l'unité · 8,40 € au total » sous une carte
function priceLine(card, quantity = 1) {
  if (!supportsPrices(card.game)) return null;
  const unit = unitPrice(state.prices.get(card.id), state.currency);
  if (unit == null) return null;
  const c = state.currency;
  return el(
    'span',
    'card-price',
    quantity > 1 ? `≈ ${formatMoney(unit, c)} l'unité · ${formatMoney(unit * quantity, c)} au total` : `≈ ${formatMoney(unit, c)}`,
  );
}

// « · valeur estimée ≈ 231,40 € (3 sans prix) » pour le résumé d'une liste
function priceSummary(items) {
  if (!state.pricesReady || !items.length) return '';
  const { total, unpriced } = sumPrices(items, state.prices, state.currency);
  if (!total && !unpriced) return '';
  const value = total ? ` · ${CFG.text.valueLabel} ≈ ${formatMoney(total, state.currency)}` : '';
  return `${value}${unpriced ? ` (${unpriced} sans prix)` : ''}`;
}

// Menu « Type » : options (éventuellement en sections) fournies par le jeu.
// Peut être rappelé quand le jeu affine sa liste (ex. après chargement du catalogue).
function fillTypeSelect() {
  if (!state.game) return;
  const keep = ui.type.value;
  ui.type.replaceChildren(new Option('Tous types', ''));
  const sections = new Map();
  const groups = state.game.provider.typeGroups;

  for (const group of groups) {
    let parent = ui.type;
    if (group.section) {
      if (!sections.has(group.section)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.section;
        ui.type.append(optgroup);
        sections.set(group.section, optgroup);
      }
      parent = sections.get(group.section);
    }
    parent.append(new Option(group.label, group.key));
  }
  ui.type.value = groups.some((g) => g.key === keep) ? keep : '';
}

// ---------- Données (Supabase) ----------

// Tes cartes (collection ou wishlist), pour le jeu choisi ou pour tous les jeux
async function loadOwned() {
  const columns = `id, quantity${CFG.notes ? ', note' : ''}${
    CFG.purchase ? ', purchased, purchase_price, purchase_currency' : ''
  }, cards!inner(${CARD_COLUMNS})`;
  const rows = await fetchAll(() => {
    let query = supabase.from(CFG.table).select(columns).eq('user_id', state.userId);
    if (state.game) query = query.eq('cards.game', state.game.id);
    return query;
  });
  state.owned = new Map(
    rows.map((r) => [
      keyOf(r.cards),
      {
        itemId: r.id,
        quantity: r.quantity,
        note: r.note ?? '',
        purchased: r.purchased ?? false,
        purchasePrice: r.purchase_price ?? null,
        purchaseCurrency: r.purchase_currency ?? null,
        card: r.cards,
      },
    ]),
  );
}

// Les wishlists de tous les utilisateurs (lecture seule), regroupées par carte
async function loadCommunity() {
  setStatus('Chargement des wishlists…');
  const rows = await fetchAll(() => {
    let query = supabase
      .from('wishlist_items')
      .select(`id, quantity, note, user_id, cards!inner(${CARD_COLUMNS})`);
    if (state.game) query = query.eq('cards.game', state.game.id);
    return query;
  });

  const { data: profiles, error } = await supabase.from('profiles').select('id, username');
  if (error) throw error;
  const names = new Map((profiles ?? []).map((p) => [p.id, p.username]));

  // ce que TU possèdes déjà (pour repérer ce que tu pourrais offrir ou échanger)
  const mine = await fetchAll(() =>
    supabase
      .from('collection_items')
      .select('id, card_id, quantity, cards!inner(game, external_id, name, card_type, data)')
      .eq('user_id', state.userId),
  );
  const owned = new Map(mine.map((r) => [r.card_id, r.quantity]));

  // la même carte dans une autre version (langue, édition) : sert à expliquer pourquoi « Proposer » n'apparaît pas
  const similar = new Map();
  for (const r of mine) {
    const identity = rulesFor(r.cards.game)?.identity(r.cards);
    if (identity == null) continue;
    const key = `${r.cards.game}:${identity}`;
    similar.set(key, (similar.get(key) ?? 0) + r.quantity);
  }

  const byCard = new Map();
  for (const r of rows) {
    const key = keyOf(r.cards);
    if (!byCard.has(key)) byCard.set(key, { card: r.cards, wanters: [] });
    byCard.get(key).wanters.push({
      userId: r.user_id,
      name: names.get(r.user_id) ?? 'utilisateur inconnu',
      quantity: r.quantity,
      note: r.note ?? '',
    });
  }
  state.community = { entries: [...byCard.values()], owned, similar };
  fillUserSelect();

  // tes offres déjà envoyées (pour ne pas en renvoyer une en attente)
  try {
    state.offers.sent = await loadSentOffers(state.userId);
    state.offers.available = true;
  } catch (err) {
    console.warn('Offres indisponibles (offers_v1.sql exécuté ?)', err);
    state.offers.sent = new Map();
    state.offers.available = false;
  }
}

// Utilisateurs qui partagent leur collection (toi exclu)
async function loadSharers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, collection_public')
    .eq('collection_public', true);
  if (error) throw error;
  state.others.sharers = (data ?? [])
    .filter((p) => p.id !== state.userId)
    .sort((a, b) => a.username.localeCompare(b.username, 'fr'));
  fillSharerSelect();
}

function fillSharerSelect() {
  if (!ui.user) return;
  const keep = ui.user.value;
  ui.user.replaceChildren(new Option('Choisir un utilisateur…', ''));
  for (const p of state.others.sharers) ui.user.append(new Option(p.username, p.id));
  ui.user.value = state.others.sharers.some((p) => p.id === keep) ? keep : '';
}

// La collection de l'utilisateur choisi (le jeu choisi), + ta wishlist pour repérer ce qui t'intéresse
async function loadOthers() {
  const userId = ui.user?.value ?? '';
  state.others.entries = [];
  state.others.wanted = new Map();
  if (!userId) return;

  setStatus('Chargement de la collection…');
  const rows = await fetchAll(() => {
    let query = supabase
      .from('collection_items')
      .select(`id, quantity, cards!inner(${CARD_COLUMNS})`)
      .eq('user_id', userId);
    if (state.game) query = query.eq('cards.game', state.game.id);
    return query;
  });
  state.others.entries = rows.map((r) => ({ card: r.cards, quantity: r.quantity }));

  try {
    const mine = await fetchAll(() => supabase.from('wishlist_items').select('id, card_id, quantity').eq('user_id', state.userId));
    state.others.wanted = new Map(mine.map((r) => [r.card_id, r.quantity]));
  } catch {
    /* pas de wishlist (script non exécuté) : simplement pas de repérage */
  }
}

// Interrupteur « Partager ma collection »
const setShareMsg = (message, isError = false) => {
  if (!ui.shareMsg) return;
  ui.shareMsg.textContent = message;
  ui.shareMsg.classList.toggle('is-error', isError);
};

async function loadShareFlag() {
  if (!ui.share) return;
  const { data, error } = await supabase.from('profiles').select('collection_public').eq('id', state.userId).maybeSingle();
  if (error) {
    console.error(error);
    ui.share.disabled = true;
    setShareMsg(friendlyError(error), true);
    return;
  }
  ui.share.checked = Boolean(data?.collection_public);
}

async function onShareChange() {
  const wanted = ui.share.checked;
  if (wanted && !confirm('Tous les utilisateurs connectés pourront voir toutes les cartes de ta collection. Continuer ?')) {
    ui.share.checked = false;
    return;
  }
  ui.share.disabled = true;
  const { error } = await supabase.from('profiles').update({ collection_public: wanted }).eq('id', state.userId);
  ui.share.disabled = false;
  if (error) {
    console.error(error);
    ui.share.checked = !wanted;
    setShareMsg(friendlyError(error), true);
    return;
  }
  setShareMsg(
    wanted
      ? 'Ta collection est visible par les autres utilisateurs connectés.'
      : 'Ta collection est de nouveau privée : toi seul peux la voir.',
  );
}

// Menu « Utilisateur » : ceux qui ont au moins une carte dans la wishlist chargée
function fillUserSelect() {
  if (!ui.user) return;
  const keep = ui.user.value;
  const users = new Map();
  for (const entry of state.community.entries) {
    for (const w of entry.wanters) users.set(w.userId, w.name);
  }
  ui.user.replaceChildren(new Option('Tous les utilisateurs', ''));
  [...users]
    .sort((a, b) => a[1].localeCompare(b[1], 'fr'))
    .forEach(([id, name]) => ui.user.append(new Option(id === state.userId ? `${name} (moi)` : name, id)));
  ui.user.value = users.has(keep) ? keep : '';
}

async function addOne(card) {
  const existing = state.owned.get(keyOf(card));
  if (existing) return setQuantity(existing, existing.quantity + 1);

  const stored = await ensureCard(card);
  const { data, error } = await supabase
    .from(CFG.table)
    .insert({ card_id: stored.id, quantity: 1 })
    .select('id, quantity')
    .single();
  if (error) throw error;
  state.owned.set(keyOf(card), {
    itemId: data.id,
    quantity: data.quantity,
    note: '',
    purchased: false,
    purchasePrice: null,
    purchaseCurrency: null,
    card: stored,
  });

  // la ligne affichée dans les résultats prend la fiche complète
  const index = state.results.findIndex((c) => keyOf(c) === keyOf(card));
  if (index !== -1) state.results[index] = stored;

  ensurePrices(); // prix de la carte qu'on vient d'ajouter
}

async function setQuantity(entry, quantity) {
  if (quantity <= 0) {
    const { error } = await supabase.from(CFG.table).delete().eq('id', entry.itemId);
    if (error) throw error;
    state.owned.delete(keyOf(entry.card));
    return;
  }
  const { error } = await supabase.from(CFG.table).update({ quantity }).eq('id', entry.itemId);
  if (error) throw error;
  entry.quantity = quantity;
}

// Wishlist : note libre (langue, état, édition souhaitée...)
async function saveNote(card, input) {
  const entry = state.owned.get(keyOf(card));
  if (!entry) return;
  const note = input.value.trim().slice(0, 140);
  if (note === entry.note) return;

  const { error } = await supabase.from(CFG.table).update({ note: note || null }).eq('id', entry.itemId);
  if (error) {
    console.error(error);
    setStatus(friendlyError(error), true);
    input.value = entry.note;
    return;
  }
  entry.note = note;
}

// Collection : achetée ou non, et à quel prix (comparé ensuite au prix du marché)
async function savePurchase(card, { purchased, price, currency }) {
  const entry = state.owned.get(keyOf(card));
  if (!entry) return;

  const patch = purchased
    ? { purchased: true, purchase_price: price, purchase_currency: currency }
    : { purchased: false, purchase_price: null, purchase_currency: null };

  const { error } = await supabase.from(CFG.table).update(patch).eq('id', entry.itemId);
  if (error) {
    console.error(error);
    setStatus(friendlyError(error), true);
    return false;
  }
  entry.purchased = patch.purchased;
  entry.purchasePrice = patch.purchase_price;
  entry.purchaseCurrency = patch.purchase_currency;
  return true;
}

// ---------- Formulaire ----------

function bindEvents() {
  bindOfferDialog();
  ui.tabMine.addEventListener('click', () => switchTab('mine'));
  ui.tabAdd.addEventListener('click', () => switchTab('add'));
  ui.tabCommunity?.addEventListener('click', () => switchTab('community'));
  ui.tabOthers?.addEventListener('click', () => switchTab('others'));
  ui.share?.addEventListener('change', onShareChange);
  ui.user?.addEventListener('change', async () => {
    if (state.tab === 'community') {
      renderList();
    } else if (state.tab === 'others') {
      try {
        await loadOthers();
      } catch (err) {
        console.error(err);
        setStatus(friendlyError(err), true);
        return;
      }
      renderList();
      ensurePrices();
    }
  });

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.tab === 'add') runSearch();
  });
  ui.text.addEventListener('input', onFilterChange);
  ui.type.addEventListener('change', onFilterChange);
  ui.mode.addEventListener('change', () => {
    applyModeUi();
    onFilterChange();
  });
  ui.more.addEventListener('click', () => runSearch({ more: true }));
}

const readForm = () => ({ mode: ui.mode.value, text: ui.text.value, type: ui.type.value });

function saveFormValues() {
  state.forms[state.tab] = readForm();
}

function loadFormValues() {
  const values = state.forms[state.tab];
  ui.mode.value = values.mode;
  ui.text.value = values.text;
  ui.type.value = values.type;
  applyModeUi();
}

function applyModeUi() {
  if (!state.game) {
    ui.textLabel.textContent = 'Nom de la carte';
    ui.text.placeholder = 'Filtrer par nom…';
    ui.text.inputMode = 'text';
    return;
  }
  const provider = state.game.provider;
  const byId = ui.mode.value === 'id';
  ui.textLabel.textContent = byId ? provider.idLabel : 'Nom de la carte';
  ui.text.placeholder = byId ? provider.idPlaceholder : provider.namePlaceholder;
  ui.text.inputMode = byId ? provider.idInputMode ?? 'text' : 'text';
}

function updateTabs() {
  ui.tabMine.setAttribute('aria-pressed', String(state.tab === 'mine'));
  ui.tabAdd.setAttribute('aria-pressed', String(state.tab === 'add'));
  ui.tabCommunity?.setAttribute('aria-pressed', String(state.tab === 'community'));
  ui.tabOthers?.setAttribute('aria-pressed', String(state.tab === 'others'));
  ui.searchBtn.hidden = state.tab !== 'add';
  if (ui.user) ui.user.closest('.field').hidden = state.tab !== 'community' && state.tab !== 'others';
}

async function switchTab(tab) {
  if (tab === state.tab || !state.chosen) return;

  // Chercher des cartes demande un jeu précis : on prend le dernier jeu utilisé
  if (tab === 'add' && !state.game) {
    const saved = readSavedGame();
    const fallback = getGame(saved) ? saved : GAMES.find((g) => g.provider)?.id;
    await selectGame(fallback);
    if (!state.game) return;
  }

  saveFormValues();
  state.tab = tab;
  loadFormValues();
  updateTabs();

  if (tab === 'community' || tab === 'others') {
    try {
      if (tab === 'community') {
        await loadCommunity();
      } else {
        await loadSharers();
        await loadOthers();
      }
    } catch (err) {
      console.error(err);
      setStatus(friendlyError(err), true);
      return;
    }
  }
  renderList();
  if (tab !== 'add') ensurePrices();
}

function onFilterChange() {
  if (state.tab === 'mine' || state.tab === 'community' || state.tab === 'others') renderList(); // filtre instantané
}

// ---------- Recherche dans l'API (onglet « Ajouter ») ----------

async function runSearch({ more = false } = {}) {
  const provider = state.game.provider;
  const query = more ? state.search.query : readForm();

  const problem = provider.validate(query);
  if (problem) {
    setStatus(problem, true);
    return;
  }

  const token = ++state.token;
  ui.searchBtn.disabled = true;
  ui.more.disabled = true;
  setStatus('Recherche en cours…');

  try {
    const res = await provider.search({
      ...query,
      offset: more ? state.search.offset : 0,
      lang: more ? state.search.lang : null,
      onProgress: (message) => token === state.token && setStatus(message),
    });
    if (token !== state.token) return;

    state.results = more ? [...state.results, ...res.cards] : res.cards;
    state.search = {
      offset: res.nextOffset,
      lang: res.lang,
      hasMore: res.hasMore,
      total: res.total,
      done: true,
      query,
    };
    fillTypeSelect(); // le jeu a pu affiner sa liste de types (catalogue chargé)
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    setStatus('Impossible de joindre la base de cartes. Réessaie dans un instant.', true);
    return;
  } finally {
    if (token === state.token) {
      ui.searchBtn.disabled = false;
      ui.more.disabled = false;
    }
  }

  if (state.tab === 'add') renderList();
}

// ---------- Affichage de la liste ----------

function matchesLocal(card, filters) {
  const text = filters.text.trim();
  if (text) {
    if (filters.mode === 'id') {
      if (!String(card.external_id).toLowerCase().includes(text.toLowerCase())) return false;
    } else if (!normalize(`${card.name} ${card.data?.name_en ?? ''}`).includes(normalize(text))) {
      return false;
    }
  }
  if (filters.type && state.game) {
    const group = state.game.provider.typeGroups.find((g) => g.key === filters.type);
    if (group && !(group.matches ? group.matches(card) : group.types.includes(card.card_type))) return false;
  }
  return true;
}

const byName = (a, b) => a.name.localeCompare(b.name, 'fr');

function shownOwned() {
  const filters = readForm();
  return [...state.owned.values()]
    .filter((entry) => matchesLocal(entry.card, filters))
    .sort((a, b) => byName(a.card, b.card));
}

// Toutes les wishlists : une ligne par carte, avec la liste de ceux qui la veulent
function shownCommunity() {
  const filters = readForm();
  const userId = ui.user?.value ?? '';
  const shown = [];
  for (const entry of state.community.entries) {
    if (!matchesLocal(entry.card, filters)) continue;
    const wanters = userId ? entry.wanters.filter((w) => w.userId === userId) : entry.wanters;
    if (wanters.length) shown.push({ card: entry.card, wanters });
  }
  return shown.sort((a, b) => byName(a.card, b.card));
}

function updateMineStatus() {
  const total = state.owned.size;
  ui.count.textContent = total ? ` (${total})` : '';
  if (state.tab !== 'mine') return;

  const shown = shownOwned();
  if (!total) {
    setStatus(CFG.text.empty);
  } else if (!shown.length) {
    setStatus(CFG.text.noMatch);
  } else {
    const copies = shown.reduce((sum, e) => sum + e.quantity, 0);
    setStatus(
      `${plural(shown.length, 'carte')} · ${pluralCopy(copies)}${priceSummary(shown.map((e) => ({ card: e.card, quantity: e.quantity })))}`,
    );
  }
  renderPurchaseSummary(shown);
}

function shownOthers() {
  const filters = readForm();
  return state.others.entries
    .filter((entry) => matchesLocal(entry.card, filters))
    .sort((a, b) => byName(a.card, b.card));
}

function renderOthers() {
  const { sharers, entries, wanted } = state.others;
  const selected = sharers.find((p) => p.id === ui.user?.value);
  const shown = shownOthers();

  if (!sharers.length) {
    setStatus("Personne ne partage sa collection pour l'instant. Chacun peut l'activer avec « Partager ma collection ».");
  } else if (!selected) {
    setStatus('Choisis un utilisateur pour voir sa collection.');
  } else if (!entries.length) {
    setStatus(`${selected.username} n'a aucune carte${state.game ? ' pour ce jeu' : ''} (ou ne partage plus sa collection).`);
  } else if (!shown.length) {
    setStatus('Aucune carte ne correspond.');
  } else {
    const copies = shown.reduce((sum, e) => sum + e.quantity, 0);
    const wished = shown.filter((e) => wanted.has(e.card.id)).length;
    setStatus(
      `Collection de ${selected.username} : ${plural(shown.length, 'carte')} · ${pluralCopy(copies)}${
        wished ? ` · ${wished} dans ta wishlist` : ''
      }${priceSummary(shown.map((e) => ({ card: e.card, quantity: e.quantity })))}`,
    );
  }
  for (const entry of shown) ui.list.append(othersRow(entry));
}

// Sous le résumé : dit clairement si des offres sont possibles, et sinon pourquoi
function offerHelpBox() {
  let box = $('offer-help');
  if (!box) {
    box = el('p', 'status offer-help');
    box.id = 'offer-help';
    box.setAttribute('aria-live', 'polite');
    ui.status.after(box);
  }
  return box;
}

function renderOfferHelp(shown) {
  const box = offerHelpBox();
  box.hidden = state.tab !== 'community';
  if (box.hidden) return;

  let text;
  let error = false;
  if (!offerUi.dialog) {
    text = "La fenêtre d'offre est absente : wishlist.html n'est pas à jour dans ton dépôt. Remplace-le, puis recharge avec Ctrl + Maj + R.";
    error = true;
  } else if (!state.offers.available) {
    text = "Les offres ne sont pas encore activées : exécute offers_v1.sql dans le SQL Editor de Supabase, puis recharge la page.";
    error = true;
  } else {
    const offerable = shown.filter(
      (e) => (state.community.owned.get(e.card.id) ?? 0) > 0 && e.wanters.some((w) => w.userId !== state.userId),
    );
    text = offerable.length
      ? `${plural(offerable.length, 'carte')} que tu peux proposer : clique sur « Proposer… » à côté du nom de la personne qui la cherche.`
      : "Aucune carte à proposer pour l'instant. Le bouton « Proposer… » apparaît quand quelqu'un d'autre cherche une carte que tu possèdes dans ta collection (même version exacte).";
  }
  box.textContent = text;
  box.classList.toggle('is-error', error);
}

function renderCommunity() {
  const shown = shownCommunity();
  if (!state.community.entries.length) {
    setStatus(`Personne n'a encore de carte dans sa wishlist${state.game ? ' pour ce jeu' : ''}.`);
  } else if (!shown.length) {
    setStatus('Aucune carte ne correspond.');
  } else {
    const wishes = shown.reduce((sum, e) => sum + e.wanters.length, 0);
    const people = new Set(shown.flatMap((e) => e.wanters.map((w) => w.userId))).size;
    setStatus(`${plural(shown.length, 'carte')} · ${plural(wishes, 'souhait')} de ${plural(people, 'utilisateur')}`);
  }
  for (const entry of shown) ui.list.append(communityRow(entry));
  renderOfferHelp(shown);
}

function renderList() {
  images.resetObserver();
  if (CFG.community && state.tab !== 'community') offerHelpBox().hidden = true;
  ui.list.replaceChildren();
  ui.more.hidden = true;

  if (state.tab === 'mine') {
    for (const entry of shownOwned()) ui.list.append(cardRow(entry.card));
    updateMineStatus();
    return;
  }

  updateMineStatus(); // met à jour le compteur de l'onglet
  if (state.tab === 'community') {
    renderCommunity();
    return;
  }
  if (state.tab === 'others') {
    renderOthers();
    return;
  }

  if (!state.results.length) {
    setStatus(
      state.search.done
        ? "Aucune carte trouvée. Essaie un autre nom (le français et l'anglais fonctionnent)."
        : 'Cherche par nom, par code ou par type pour ajouter une carte.',
    );
    return;
  }
  const { total, hasMore } = state.search;
  setStatus(
    total == null
      ? `${plural(state.results.length, 'résultat')}${hasMore ? " (il y en a d'autres)" : ''}`
      : `${state.results.length} sur ${plural(total, 'résultat')}`,
  );
  for (const card of state.results) ui.list.append(cardRow(card));
  ui.more.hidden = !state.search.hasMore;
}

function stepButton(symbol, label, action, handler) {
  const button = el('button', 'step', symbol);
  button.type = 'button';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', handler);
  return button;
}

// Collection : « Achetée ? » + prix payé, comparé au prix actuel du marché
function purchaseBlock(card, entry) {
  const box = el('div', 'purchase-box');

  const label = el('label', 'check purchase-check');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = entry.purchased;
  label.append(checkbox, ' Achetée');
  box.append(label);

  const fields = el('div', 'purchase-fields');
  fields.hidden = !entry.purchased;

  const priceInput = document.createElement('input');
  priceInput.type = 'text';
  priceInput.inputMode = 'decimal';
  priceInput.className = 'purchase-price';
  priceInput.placeholder = 'Prix payé';
  priceInput.setAttribute('aria-label', `Prix payé pour ${card.name} (par exemplaire)`);
  if (entry.purchasePrice != null) priceInput.value = String(entry.purchasePrice).replace('.', ',');

  const currencySelect = document.createElement('select');
  currencySelect.setAttribute('aria-label', 'Devise du prix payé');
  currencySelect.append(new Option('€', 'eur'), new Option('$', 'usd'));
  currencySelect.value = entry.purchaseCurrency ?? state.currency ?? 'eur';

  fields.append(priceInput, currencySelect, el('small', 'field-hint', 'par exemplaire'));
  box.append(fields);

  const compare = el('p', 'purchase-compare');
  box.append(compare);

  function renderCompare() {
    compare.textContent = '';
    compare.className = 'purchase-compare';
    if (!entry.purchased || entry.purchasePrice == null) return;
    if (!state.pricesReady) {
      compare.textContent = 'Comparaison au prix du marché : en attente des prix…';
      return;
    }
    const market = unitPrice(state.prices.get(card.id), entry.purchaseCurrency);
    if (market == null) {
      compare.textContent = 'Prix du marché inconnu pour cette carte : pas de comparaison possible.';
      return;
    }
    const diff = market - entry.purchasePrice;
    const money = (v) => formatMoney(Math.abs(v), entry.purchaseCurrency);
    if (Math.abs(diff) < 0.01) {
      compare.textContent = `Achetée au prix du marché actuel (≈ ${money(market)}).`;
    } else if (diff > 0) {
      compare.classList.add('is-gain');
      compare.textContent = `Plus-value potentielle : +${money(diff)} (marché ≈ ${money(market)} contre ${money(entry.purchasePrice)} payé).`;
    } else {
      compare.classList.add('is-loss');
      compare.textContent = `Moins-value potentielle : −${money(diff)} (marché ≈ ${money(market)} contre ${money(entry.purchasePrice)} payé).`;
    }
  }
  renderCompare();

  async function save() {
    const purchased = checkbox.checked;
    let price = null;
    const currency = currencySelect.value;
    if (purchased) {
      price = Number(priceInput.value.trim().replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(price) || price < 0 || price > 100000) {
        setStatus('Entre un prix payé valide (ex. 4,50).', true);
        priceInput.focus();
        checkbox.checked = entry.purchased; // on ne change pas la case tant que le prix n'est pas valide
        fields.hidden = !entry.purchased;
        return;
      }
      price = Math.round(price * 100) / 100;
    }
    const ok = await savePurchase(card, { purchased, price, currency });
    if (ok) renderCompare();
  }

  checkbox.addEventListener('change', () => {
    fields.hidden = !checkbox.checked;
    if (checkbox.checked) {
      // on attend un prix valide avant d'enregistrer : cocher seul ne suffit pas
      priceInput.focus();
    } else {
      save(); // décocher vide et enregistre tout de suite
    }
  });
  priceInput.addEventListener('change', save);
  currencySelect.addEventListener('change', save);

  return box;
}

function cardRow(card, existingThumb = null) {
  const entry = state.owned.get(keyOf(card));
  const quantity = entry?.quantity ?? 0;

  const row = el('li', 'card-row');
  row.dataset.id = keyOf(card);

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', card.name));
  info.append(el('span', 'card-meta', providerOf(card)?.metaLine?.(card) ?? ''));
  const price = priceLine(card, entry?.quantity ?? 1);
  if (price) info.append(price);

  // Collection : achetée ou non, et comparaison avec le prix du marché
  if (CFG.purchase && state.tab === 'mine' && entry) {
    info.append(purchaseBlock(card, entry));
  }

  // Wishlist : une note libre sur chaque carte (langue, état, édition souhaitée...)
  if (CFG.notes && state.tab === 'mine' && entry) {
    const note = el('input', 'note-input');
    note.type = 'text';
    note.maxLength = 140;
    note.value = entry.note;
    note.placeholder = 'Ajouter une note (langue, état, édition…)';
    note.setAttribute('aria-label', `Note pour ${card.name}`);
    note.addEventListener('change', () => saveNote(card, note));
    info.append(note);
  }

  if (card.data?.desc) {
    const details = el('details', 'card-desc');
    details.append(el('summary', null, 'Texte de la carte'), el('p', null, card.data.desc));
    info.append(details);
  }

  const actions = el('div', 'card-actions');
  if (state.tab === 'mine') {
    actions.append(
      stepButton('−', CFG.text.minus, 'minus', (e) => changeQuantity(card, -1, e.currentTarget)),
      el('span', 'qty', String(quantity)),
      stepButton('+', CFG.text.plus, 'plus', (e) => changeQuantity(card, +1, e.currentTarget)),
    );
  } else {
    if (quantity) actions.append(el('span', 'badge', `${CFG.text.badge} ×${quantity}`));
    const add = el('button', 'btn-small', quantity ? '+ 1 exemplaire' : CFG.text.add);
    add.type = 'button';
    add.dataset.action = 'add';
    add.addEventListener('click', (e) => changeQuantity(card, +1, e.currentTarget));
    actions.append(add);
  }

  const main = el('div', 'card-main');
  if (SHOW_IMAGES) main.append(existingThumb ?? thumbnail(card));
  main.append(info);

  row.append(main, actions);
  return row;
}

// « Toutes les wishlists » : la carte, et qui la veut (avec quantité et note)
function communityRow(entry) {
  const { card, wanters } = entry;
  const row = el('li', 'card-row');
  row.dataset.id = keyOf(card);

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', card.name));
  info.append(el('span', 'card-meta', providerOf(card)?.metaLine?.(card) ?? ''));
  const price = priceLine(card);
  if (price) info.append(price);

  const haveIt = state.community.owned.get(card.id) ?? 0;
  const list = el('ul', 'wanters');
  for (const w of [...wanters].sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
    const item = el('li', w.userId === state.userId ? 'is-me' : null);
    item.append(el('strong', null, w.userId === state.userId ? `${w.name} (moi)` : w.name));
    item.append(el('span', null, ` ×${w.quantity}`));
    if (w.note) item.append(el('em', null, ` — « ${w.note} »`));
    if (w.userId !== state.userId && haveIt > 0 && state.offers.available && offerUi.dialog) {
      item.append(offerControl(card, w, haveIt));
    }
    list.append(item);
  }
  info.append(list);

  // tu n'as pas cette version exacte, mais une autre : on l'explique au lieu de rester silencieux
  if (!haveIt && state.offers.available && wanters.some((w) => w.userId !== state.userId)) {
    const other = state.community.similar.get(`${card.game}:${rulesFor(card.game)?.identity(card)}`) ?? 0;
    if (other > 0) {
      info.append(
        el(
          'p',
          'field-hint offer-hint',
          `Tu possèdes déjà une autre version de cette carte (×${other}) : une offre doit porter sur la version exacte qu'ils cherchent.`,
        ),
      );
    }
  }

  if (card.data?.desc) {
    const details = el('details', 'card-desc');
    details.append(el('summary', null, 'Texte de la carte'), el('p', null, card.data.desc));
    info.append(details);
  }

  const actions = el('div', 'card-actions');
  if (haveIt) actions.append(el('span', 'badge', `Dans ta collection ×${haveIt}`));

  const main = el('div', 'card-main');
  if (SHOW_IMAGES) main.append(thumbnail(card));
  main.append(info);
  row.append(main, actions);
  return row;
}

// ---------- Proposer une carte (don ou vente) à quelqu'un qui la cherche ----------

const offerUi = {
  dialog: $('offer-dialog'),
  form: $('offer-form'),
  summary: $('offer-summary'),
  priceField: $('offer-price-field'),
  price: $('offer-price'),
  currency: $('offer-currency'),
  hint: $('offer-price-hint'),
  qty: $('offer-qty'),
  qtyHint: $('offer-qty-hint'),
  message: $('offer-message'),
  error: $('offer-error'),
  send: $('offer-send'),
  cancel: $('offer-cancel'),
};

let offerTarget = null; // { card, wanter, max }
let priceTouched = false; // le prix a été tapé à la main : on ne le remplace plus

const offerKind = () => offerUi.form.querySelector('input[name="kind"]:checked').value;
const offerQuantity = () => Math.min(Math.max(parseInt(offerUi.qty.value, 10) || 1, 1), offerTarget?.max ?? 1);

// À côté de chaque personne qui cherche la carte : « Proposer… » ou l'état de ta dernière offre
function offerControl(card, wanter, owned) {
  const wrap = el('span', 'offer-control');
  const last = state.offers.sent.get(`${wanter.userId}:${card.id}`);

  if (last?.status === 'pending') {
    wrap.append(el('span', 'offer-pill is-pending', 'Offre envoyée · en attente'));
    return wrap;
  }
  const button = el('button', 'btn-outline-small offer-btn', 'Proposer…');
  button.type = 'button';
  button.dataset.action = 'offer';
  button.title = `Proposer cette carte à ${wanter.name}`;
  button.addEventListener('click', () => openOfferDialog(card, wanter, owned));
  wrap.append(button);

  const past = { accepted: 'Dernière offre acceptée', declined: 'Dernière offre refusée' }[last?.status];
  if (past) wrap.append(el('span', `offer-pill is-${last.status}`, past));
  return wrap;
}

function openOfferDialog(card, wanter, owned) {
  if (!offerUi.dialog?.showModal) return;
  const max = Math.min(owned, wanter.quantity);
  offerTarget = { card, wanter, max };
  priceTouched = false;

  offerUi.form.reset();
  offerUi.currency.value = state.currency === 'usd' ? 'USD' : 'EUR';
  offerUi.qty.max = String(max);
  offerUi.qty.value = '1';
  offerUi.qtyHint.textContent = `${wanter.name} en cherche ×${wanter.quantity}, tu en as ×${owned}.`;
  offerUi.summary.textContent = `« ${card.name} » pour ${wanter.name}`;
  offerUi.error.textContent = '';
  refreshOfferForm();
  offerUi.dialog.showModal();
  offerUi.form.querySelector('input[name="kind"]:checked').focus();
}

// Champ « prix » visible seulement pour une vente, avec le prix du marché comme repère
function refreshOfferForm() {
  if (!offerTarget) return;
  const sale = offerKind() === 'sale';
  offerUi.priceField.hidden = !sale;
  if (!sale) return;

  const key = offerUi.currency.value === 'USD' ? 'usd' : 'eur';
  const unit = unitPrice(state.prices.get(offerTarget.card.id), key);
  const qty = offerQuantity();
  if (unit == null) {
    offerUi.hint.textContent = 'Aucun prix indicatif connu pour cette carte : fixe le prix que tu veux.';
    return;
  }
  const suggested = unit * qty;
  offerUi.hint.textContent = `Prix indicatif du marché : ≈ ${formatMoney(suggested, key)} pour ${qty} exemplaire${qty > 1 ? 's' : ''}.`;
  if (!priceTouched) offerUi.price.value = suggested.toFixed(2).replace('.', ',');
}

async function submitOffer(event) {
  event.preventDefault();
  const target = offerTarget;
  if (!target) return;
  offerUi.error.textContent = '';

  const quantity = parseInt(offerUi.qty.value, 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > target.max) {
    offerUi.error.textContent = `Choisis un nombre d'exemplaires entre 1 et ${target.max}.`;
    return;
  }
  const kind = offerKind();
  let price = null;
  if (kind === 'sale') {
    price = Number(offerUi.price.value.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(price) || price <= 0 || price > 100000) {
      offerUi.error.textContent = 'Entre un prix valide (ex. 4,50).';
      offerUi.price.focus();
      return;
    }
    price = Math.round(price * 100) / 100;
  }

  offerUi.send.disabled = true;
  try {
    const offer = await createOffer({
      toUser: target.wanter.userId,
      cardId: target.card.id,
      kind,
      price,
      currency: offerUi.currency.value,
      quantity,
      message: offerUi.message.value.trim(),
    });
    state.offers.sent.set(`${target.wanter.userId}:${target.card.id}`, offer);
    offerUi.dialog.close();
    renderList();
    setStatus(`Offre envoyée à ${target.wanter.name} : la personne est notifiée et pourra accepter ou refuser.`);
  } catch (err) {
    console.error(err);
    offerUi.error.textContent = err.friendly ? err.message : friendlyError(err);
  } finally {
    offerUi.send.disabled = false;
  }
}

function bindOfferDialog() {
  if (!offerUi.dialog) return;
  offerUi.form.addEventListener('submit', submitOffer);
  offerUi.form.addEventListener('change', refreshOfferForm);
  offerUi.qty.addEventListener('input', refreshOfferForm);
  offerUi.price.addEventListener('input', () => {
    priceTouched = true;
  });
  offerUi.cancel.addEventListener('click', () => offerUi.dialog.close());
}

// « Collections des autres » : lecture seule, avec ce qui t'intéresse
function othersRow(entry) {
  const { card, quantity } = entry;
  const row = el('li', 'card-row');
  row.dataset.id = keyOf(card);

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', card.name));
  info.append(el('span', 'card-meta', providerOf(card)?.metaLine?.(card) ?? ''));
  const price = priceLine(card, quantity);
  if (price) info.append(price);
  if (card.data?.desc) {
    const details = el('details', 'card-desc');
    details.append(el('summary', null, 'Texte de la carte'), el('p', null, card.data.desc));
    info.append(details);
  }

  const actions = el('div', 'card-actions');
  const wanted = state.others.wanted.get(card.id) ?? 0;
  if (wanted) actions.append(el('span', 'badge badge-wish', `Dans ta wishlist ×${wanted}`));
  const mine = state.owned.get(keyOf(card))?.quantity ?? 0;
  if (mine) actions.append(el('span', 'badge', `Tu en as ×${mine}`));
  actions.append(el('span', 'qty', `×${quantity}`));

  const main = el('div', 'card-main');
  if (SHOW_IMAGES) main.append(thumbnail(card));
  main.append(info);
  row.append(main, actions);
  return row;
}

// Met à jour une seule ligne (sans reconstruire toute la liste)
function patchRow(key, focusAction) {
  const old = ui.list.querySelector(`[data-id="${CSS.escape(key)}"]`);
  if (!old) return;

  const card =
    state.tab === 'mine'
      ? state.owned.get(key)?.card
      : state.results.find((c) => keyOf(c) === key);

  if (!card) {
    // carte retirée de la liste : on déplace le focus sur la ligne voisine
    const neighbour = old.nextElementSibling ?? old.previousElementSibling;
    old.remove();
    neighbour?.querySelector('button')?.focus();
  } else {
    const fresh = cardRow(card, old.querySelector('.card-thumb')); // on garde l'image déjà chargée
    old.replaceWith(fresh);
    fresh.querySelector(`[data-action="${focusAction}"]`)?.focus();
  }
  updateMineStatus();
}

async function changeQuantity(card, delta, button) {
  const entry = state.owned.get(keyOf(card));
  const action = button.dataset.action;
  const row = button.closest('li');

  if (delta < 0 && entry?.quantity === 1 && !confirm(CFG.text.confirmRemove)) return;

  // on ne bloque que les boutons d'action : la miniature doit rester cliquable
  const actionButtons = row.querySelectorAll('.card-actions button');
  actionButtons.forEach((b) => (b.disabled = true));
  try {
    if (delta > 0) await addOne(card);
    else if (entry) await setQuantity(entry, entry.quantity - 1);
  } catch (err) {
    console.error(err);
    if (err?.code === '23505') {
      // la carte existait déjà (autre onglet) : on recharge l'état réel
      await loadOwned().catch(() => {});
      renderList();
      return;
    }
    setStatus(friendlyError(err), true);
    actionButtons.forEach((b) => (b.disabled = false));
    return;
  }
  patchRow(keyOf(card), action);
}

// ---------- Démarrage : session obligatoire ----------
// (en fin de fichier : tout le reste doit être défini avant de s'exécuter)

const session = await bootPage({ version: APP_VERSION, files: ALL_FILES });
if (session) await start(session);

async function start(session) {
  state.userId = session.user.id;
  bindEvents();
  renderGames();
  initCurrencyToggle((currency) => {
    state.currency = currency;
    refreshPriceUi();
    if (state.priceCards.length) setPriceNote(priceInfo(state.priceCards));
  });
  await revealPage(session); // affiche la page tout de suite, puis le pseudo
  if (CFG.others) await loadShareFlag();

  // dernier choix mémorisé ; sur la wishlist, « Tous les jeux » par défaut
  const saved = readSavedGame();
  if (saved === 'all' && CFG.allGames) await selectGame('all');
  else if (saved && getGame(saved)) await selectGame(saved);
  else if (CFG.allGames) await selectGame('all');
}
