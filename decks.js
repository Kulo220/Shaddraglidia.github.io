// =====================================================================
// Page decks
//  - liste : « Mes decks » et « Decks publiés » (filtrables par jeu / auteur)
//  - éditeur : cartes par zone, règles du jeu appliquées (ajouts interdits bloqués)
//  - publication : un deck publié est lisible et copiable par tous
//  - cartes manquantes : comparaison avec ta collection, ajout à la wishlist
// L'adresse decks.html#<id> ouvre directement un deck (lien partageable).
// =====================================================================

import { supabase } from './config.js';
import { GAMES, getGame } from './games.js?v=19';
import {
  $, el, plural, keyOf, providerOf, friendlyError, fetchAll, ensureCard, createImages,
  bootPage, revealPage, ALL_FILES, SHOW_IMAGES, CARD_COLUMNS,
} from './common.js?v=19';
import {
  rulesFor, canAdd, autoZone, alternativeZones, evaluate, missingCards, ownedByIdentity, zonesOf, rangeText,
} from './deck-rules.js?v=19';
import {
  getCurrency, initCurrencyToggle, formatMoney, supportsPrices, unitPrice, loadPrices, refreshPrices, sumPrices,
  latestUpdate, CURRENCIES,
} from './prices.js?v=19';

const APP_VERSION = '19';

// ---------- Éléments de la page ----------

const ui = {
  viewList: $('view-list'),
  viewDeck: $('view-deck'),
  games: $('games'),
  tabMine: $('tab-mine'),
  tabPublic: $('tab-public'),
  count: $('count'),
  listForm: $('list-form'),
  listText: $('list-text'),
  authorField: $('author-field'),
  author: $('author'),
  newBtn: $('new-deck-btn'),
  newForm: $('new-deck'),
  newName: $('new-name'),
  newGame: $('new-game'),
  newFormatField: $('new-format-field'),
  newFormat: $('new-format'),
  newCancel: $('new-cancel'),
  status: $('status'),
  deckList: $('deck-list'),

  back: $('back'),
  deckName: $('deck-name'),
  deckOwner: $('deck-owner'),
  deckSub: $('deck-sub'),
  formatField: $('format-field'),
  deckFormat: $('deck-format'),
  deckDesc: $('deck-desc'),
  publicField: $('public-field'),
  deckPublic: $('deck-public'),
  copyLink: $('copy-link'),
  copyDeck: $('copy-deck'),
  deleteDeck: $('delete-deck'),
  summary: $('deck-summary'),
  deckMsg: $('deck-msg'),
  dtabDeck: $('dtab-deck'),
  dtabAdd: $('dtab-add'),
  deckCount: $('deck-count'),
  panelDeck: $('panel-deck'),
  panelAdd: $('panel-add'),
  missing: $('missing'),
  missingText: $('missing-text'),
  deckValue: $('deck-value'),
  priceNote: $('price-note'),
  ignoreBasics: $('ignore-basics'),
  missingWish: $('missing-wish'),
  zones: $('zones'),

  searchForm: $('search-form'),
  mode: $('mode'),
  text: $('text'),
  textLabel: $('text-label'),
  type: $('type'),
  searchBtn: $('search-btn'),
  addStatus: $('add-status'),
  results: $('results'),
  more: $('more'),

  lightbox: $('lightbox'),
  lightboxImg: $('lightbox-img'),
  lightboxName: $('lightbox-name'),
  lightboxMeta: $('lightbox-meta'),
};

const setText = (node, message, isError = false) => {
  node.textContent = message;
  node.classList.toggle('is-error', isError);
};
const setStatus = (m, e) => setText(ui.status, m, e);
const setDeckMsg = (m, e) => setText(ui.deckMsg, m, e);
const setAddMsg = (m, e) => setText(ui.addStatus, m, e);

const images = createImages({
  lightbox: ui.lightbox,
  img: ui.lightboxImg,
  name: ui.lightboxName,
  meta: ui.lightboxMeta,
  onError: (message) => setDeckMsg(message, true),
});
const thumbnail = images.thumbnail;

// ---------- État ----------

const state = {
  userId: null,
  names: new Map(), // id utilisateur -> pseudo
  gameId: 'all', // filtre de la liste
  listTab: 'mine', // 'mine' | 'public'
  decks: [],
  counts: new Map(), // id deck -> nombre de cartes
  deck: null, // deck ouvert : { id, user_id, game, format, name, ..., cards: [{ id, zone, quantity, card }] }
  tab: 'deck', // 'deck' | 'add'
  owned: new Map(), // identité de carte -> exemplaires que TU possèdes
  missingByIdentity: new Map(),
  ignoreBasics: readIgnoreBasics(),
  prices: new Map(), // id de carte -> { eur, usd, updated_at } (table partagée card_prices)
  currency: getCurrency(),
  pricesReady: false,
  results: [],
  search: { offset: 0, lang: null, hasMore: false, total: 0, done: false, query: null },
  token: 0,
};

function readIgnoreBasics() {
  try {
    return localStorage.getItem('tcg:deck:ignoreBasics') !== '0';
  } catch {
    return true;
  }
}
function saveIgnoreBasics(value) {
  try {
    localStorage.setItem('tcg:deck:ignoreBasics', value ? '1' : '0');
  } catch {
    /* pas grave */
  }
}

const isOwner = () => state.deck?.user_id === state.userId;
const gameLabel = (id) => GAMES.find((g) => g.id === id)?.label ?? id;
const formatLabel = (game, format) => rulesFor(game)?.formats?.find((f) => f.key === format)?.label.split(' (')[0] ?? '';
const authorName = (userId) => (userId === state.userId ? 'moi' : state.names.get(userId) ?? 'utilisateur inconnu');
const dateFr = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '');
const totalCards = (deck) => deck.cards.reduce((sum, row) => sum + row.quantity, 0);

// =====================================================================
// LISTE DES DECKS
// =====================================================================

function renderGames() {
  ui.games.replaceChildren();
  const make = (id, label) => {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(state.gameId === id));
    chip.addEventListener('click', () => {
      state.gameId = id;
      renderGames();
      renderList();
    });
    ui.games.append(chip);
  };
  make('all', 'Tous les jeux');
  for (const game of GAMES) if (game.provider) make(game.id, game.label);
}

async function loadNames() {
  const { data } = await supabase.from('profiles').select('id, username');
  state.names = new Map((data ?? []).map((p) => [p.id, p.username]));
}

async function loadList() {
  setStatus('Chargement des decks…');
  ui.deckList.replaceChildren();
  try {
    const rows = await fetchAll(() => {
      const query = supabase.from('decks').select('*');
      return state.listTab === 'mine' ? query.eq('user_id', state.userId) : query.eq('is_public', true);
    });
    state.decks = rows;

    // nombre de cartes de chaque deck
    state.counts = new Map();
    const ids = rows.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const cards = await fetchAll(() => supabase.from('deck_cards').select('id, deck_id, quantity').in('deck_id', part));
      for (const c of cards) state.counts.set(c.deck_id, (state.counts.get(c.deck_id) ?? 0) + c.quantity);
    }
  } catch (err) {
    console.error(err);
    setStatus(friendlyError(err), true);
    return;
  }
  ui.count.textContent = state.listTab === 'mine' && state.decks.length ? ` (${state.decks.length})` : '';
  fillAuthorSelect();
  renderList();
}

function fillAuthorSelect() {
  const keep = ui.author.value;
  const authors = new Map();
  for (const deck of state.decks) authors.set(deck.user_id, authorName(deck.user_id));
  ui.author.replaceChildren(new Option('Tous les auteurs', ''));
  [...authors]
    .sort((a, b) => a[1].localeCompare(b[1], 'fr'))
    .forEach(([id, name]) => ui.author.append(new Option(id === state.userId ? 'moi' : name, id)));
  ui.author.value = authors.has(keep) ? keep : '';
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function shownDecks() {
  const text = norm(ui.listText.value);
  const author = state.listTab === 'public' ? ui.author.value : '';
  return state.decks
    .filter((d) => state.gameId === 'all' || d.game === state.gameId)
    .filter((d) => !text || norm(d.name).includes(text))
    .filter((d) => !author || d.user_id === author)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

function deckItem(deck) {
  const li = el('li', 'card-row deck-item');
  li.dataset.id = deck.id;

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', deck.name));
  const parts = [gameLabel(deck.game)];
  const format = formatLabel(deck.game, deck.format);
  if (format) parts.push(format);
  parts.push(plural(state.counts.get(deck.id) ?? 0, 'carte'));
  if (state.listTab === 'public') parts.push(`par ${authorName(deck.user_id)}`);
  parts.push(`modifié le ${dateFr(deck.updated_at)}`);
  info.append(el('span', 'card-meta', parts.join(' · ')));
  if (deck.description) info.append(el('span', 'deck-blurb', deck.description));

  const actions = el('div', 'card-actions');
  if (deck.is_public && state.listTab === 'mine') actions.append(el('span', 'badge', 'Publié'));
  const open = el('button', 'btn-small', 'Ouvrir');
  open.type = 'button';
  open.addEventListener('click', () => {
    location.hash = `#${deck.id}`;
  });
  actions.append(open);

  li.append(info, actions);
  return li;
}

function renderList() {
  ui.deckList.replaceChildren();
  const shown = shownDecks();
  if (!state.decks.length) {
    setStatus(
      state.listTab === 'mine'
        ? "Tu n'as pas encore de deck. Clique sur « Nouveau deck » pour commencer."
        : "Aucun deck n'est publié pour l'instant.",
    );
  } else if (!shown.length) {
    setStatus('Aucun deck ne correspond.');
  } else {
    setStatus(plural(shown.length, 'deck'));
  }
  for (const deck of shown) ui.deckList.append(deckItem(deck));
}

function setListTab(tab) {
  state.listTab = tab;
  ui.tabMine.setAttribute('aria-pressed', String(tab === 'mine'));
  ui.tabPublic.setAttribute('aria-pressed', String(tab === 'public'));
  ui.authorField.hidden = tab !== 'public';
  ui.newBtn.hidden = tab !== 'mine';
  if (tab !== 'mine') ui.newForm.hidden = true;
  return loadList();
}

// ---------- Nouveau deck ----------

function openNewForm() {
  ui.newGame.replaceChildren();
  const preset = state.gameId !== 'all' ? state.gameId : null;
  for (const game of GAMES) if (game.provider) ui.newGame.append(new Option(game.label, game.id));
  if (preset) ui.newGame.value = preset;
  fillNewFormats();
  ui.newName.value = '';
  ui.newForm.hidden = false;
  ui.newName.focus();
}

function fillNewFormats() {
  const formats = rulesFor(ui.newGame.value)?.formats;
  ui.newFormatField.hidden = !formats;
  ui.newFormat.replaceChildren();
  for (const f of formats ?? []) ui.newFormat.append(new Option(f.label, f.key));
}

async function createDeck(event) {
  event.preventDefault();
  const name = ui.newName.value.trim();
  if (!name) {
    setStatus('Donne un nom à ton deck.', true);
    ui.newName.focus();
    return;
  }
  const game = ui.newGame.value;
  const rules = rulesFor(game);
  const format = rules?.formats ? ui.newFormat.value : null;

  ui.newForm.querySelector('#new-create').disabled = true;
  const { data, error } = await supabase.from('decks').insert({ name, game, format }).select('*').single();
  ui.newForm.querySelector('#new-create').disabled = false;
  if (error) {
    console.error(error);
    setStatus(friendlyError(error), true);
    return;
  }
  ui.newForm.hidden = true;
  location.hash = `#${data.id}`;
}

// =====================================================================
// UN DECK
// =====================================================================

function showView(name) {
  ui.viewList.hidden = name !== 'list';
  ui.viewDeck.hidden = name !== 'deck';
}

async function openList(message = null) {
  state.deck = null;
  state.results = [];
  showView('list');
  await loadList();
  if (message) setStatus(message, true);
}

const deckIdFromHash = () => location.hash.match(/^#([\w-]{2,64})$/)?.[1] ?? null;

function route() {
  const id = deckIdFromHash();
  const task = id ? openDeck(id) : openList();
  task.catch((err) => {
    console.error(err);
    (id ? setDeckMsg : setStatus)(friendlyError(err), true);
  });
}

async function loadOwned(gameId) {
  const rules = rulesFor(gameId);
  if (!rules) return new Map();
  const rows = await fetchAll(() =>
    supabase
      .from('collection_items')
      .select(`id, quantity, cards!inner(${CARD_COLUMNS})`)
      .eq('user_id', state.userId)
      .eq('cards.game', gameId),
  );
  return ownedByIdentity(gameId, rows.map((r) => ({ card: r.cards, quantity: r.quantity })));
}

async function openDeck(id) {
  showView('deck');
  setDeckMsg('Chargement du deck…');
  ui.zones.replaceChildren();
  ui.summary.replaceChildren();
  ui.missing.hidden = true;
  state.deck = null;
  state.results = [];
  state.search = { offset: 0, lang: null, hasMore: false, total: 0, done: false, query: null };

  try {
    const { data: deck, error } = await supabase.from('decks').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!deck) {
      setDeckMsg('');
      history.replaceState(null, '', location.pathname);
      await openList('Deck introuvable, ou privé.');
      return;
    }
    const rows = await fetchAll(() =>
      supabase.from('deck_cards').select(`id, zone, quantity, cards!inner(${CARD_COLUMNS})`).eq('deck_id', id),
    );
    state.owned = await loadOwned(deck.game);
    state.deck = {
      ...deck,
      cards: rows.map((r) => ({ id: r.id, zone: r.zone, quantity: r.quantity, card: r.cards })),
    };
  } catch (err) {
    console.error(err);
    setDeckMsg(friendlyError(err), true);
    return;
  }

  fillDeckHeader();
  setDeckTab('deck');
  setDeckMsg('');
  renderDeck();
  ensurePrices();
}

function fillDeckHeader() {
  const deck = state.deck;
  const owner = isOwner();
  const rules = rulesFor(deck.game);

  ui.deckName.value = deck.name;
  ui.deckName.readOnly = !owner;
  ui.deckOwner.textContent = owner ? 'Mon deck' : `par ${authorName(deck.user_id)}`;

  ui.formatField.hidden = !rules?.formats;
  ui.deckFormat.replaceChildren();
  for (const f of rules?.formats ?? []) ui.deckFormat.append(new Option(f.label, f.key));
  if (rules?.formats) ui.deckFormat.value = deck.format ?? rules.defaultFormat;
  ui.deckFormat.disabled = !owner;

  ui.deckDesc.value = deck.description ?? '';
  ui.deckDesc.readOnly = !owner;
  ui.deckDesc.placeholder = owner ? 'Stratégie, points forts, conseils…' : '';

  ui.publicField.hidden = !owner;
  ui.deckPublic.checked = deck.is_public;
  ui.copyLink.hidden = !deck.is_public;
  ui.copyDeck.textContent = owner ? 'Dupliquer' : 'Copier dans mes decks';
  ui.deleteDeck.hidden = !owner;
  ui.dtabAdd.hidden = !owner;
  ui.ignoreBasics.checked = state.ignoreBasics;
  updateDeckSub();

  if (owner) prepareSearchPanel();
}

function updateDeckSub() {
  const deck = state.deck;
  const parts = [gameLabel(deck.game)];
  const format = formatLabel(deck.game, deck.format);
  if (format) parts.push(format);
  parts.push(deck.is_public ? 'publié' : 'privé');
  parts.push(`modifié le ${dateFr(deck.updated_at)}`);
  ui.deckSub.textContent = parts.join(' · ');
}

// ---------- Affichage du deck ----------

function renderDeck() {
  const deck = state.deck;
  if (!deck) return;
  const ev = evaluate(deck);

  // cartes manquantes par rapport à TA collection (avant l'affichage des lignes)
  const missing = missingCards(deck, state.owned, { ignoreBasics: state.ignoreBasics });
  state.missingByIdentity = new Map(missing.lines.map((l) => [l.identity, l]));

  renderSummary(ev);
  renderMissing(missing);
  renderZones(ev);
  ui.deckCount.textContent = totalCards(deck) ? ` (${totalCards(deck)})` : '';
  if (isOwner()) refreshResultActions();
}

function renderSummary(ev) {
  ui.summary.replaceChildren();
  const box = el('div', ev.legal ? 'summary-ok' : 'summary-warn');
  box.append(el('strong', null, ev.legal ? '✓ Deck complet et légal' : 'Deck incomplet ou non légal'));
  if (!ev.legal) {
    const list = el('ul', 'issues');
    for (const issue of ev.issues) list.append(el('li', null, issue));
    box.append(list);
  }
  const notes = rulesFor(state.deck.game)?.notes;
  if (notes) box.append(el('p', 'summary-note', notes));
  ui.summary.append(box);
}

function renderMissing(missing) {
  const deck = state.deck;
  if (!deck.cards.length) {
    ui.missing.hidden = true;
    return;
  }
  ui.missing.hidden = false;

  let text =
    missing.totalMissing === 0
      ? '✓ Tu possèdes toutes les cartes de ce deck.'
      : `Il te manque ${plural(missing.totalMissing, 'carte')} sur ${missing.totalNeeded}.`;

  // coût des cartes manquantes et valeur du deck (quand les prix sont chargés)
  ui.deckValue.textContent = '';
  if (state.pricesReady && supportsPrices(deck.game)) {
    const money = (n) => formatMoney(n, state.currency);
    if (missing.totalMissing > 0) {
      const { cost, unpriced } = missingCost(missing);
      if (cost) text += ` À acheter ≈ ${money(cost)}${unpriced ? ` (${unpriced} sans prix)` : ''}.`;
    }
    const value = sumPrices(deck.cards.map((r) => ({ card: r.card, quantity: r.quantity })), state.prices, state.currency);
    if (value.total) ui.deckValue.textContent = `Valeur du deck ≈ ${money(value.total)}${value.unpriced ? ` (${value.unpriced} sans prix)` : ''}`;
  }
  ui.missingText.textContent = text;
  ui.missingWish.hidden = missing.totalMissing === 0;
}

function renderZones(ev) {
  ui.zones.replaceChildren();
  images.resetObserver();
  for (const report of ev.zones) {
    if (report.zone.orphan && !report.count) continue;

    const section = el('section', 'zone');
    const head = el('h3', 'zone-title');
    head.append(el('span', null, report.zone.label));
    head.append(el('span', `zone-count is-${report.state}`, `${report.count} / ${rangeText(report.zone)}`));
    section.append(head);

    const list = el('ul', 'cards zone-list');
    const rows = [...report.rows].sort((a, b) => a.card.name.localeCompare(b.card.name, 'fr'));
    for (const row of rows) list.append(deckRow(row));
    if (!rows.length) list.append(el('li', 'zone-empty', 'Aucune carte'));
    section.append(list);
    ui.zones.append(section);
  }
}

function stepButton(symbol, label, action, disabled, handler) {
  const button = el('button', 'step', symbol);
  button.type = 'button';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', handler);
  return button;
}

function deckRow(row) {
  const li = el('li', 'card-row deck-row');
  li.dataset.id = row.id;
  const card = row.card;

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', card.name));
  info.append(el('span', 'card-meta', providerOf(card)?.metaLine?.(card) ?? ''));

  const unit = moneyOf(card);
  if (unit != null) info.append(el('span', 'card-price', `≈ ${formatMoney(unit, state.currency)}`));

  // ce que TU possèdes de cette carte
  const rules = rulesFor(state.deck.game);
  const line = state.missingByIdentity.get(rules.identity(card));
  if (line) {
    const ok = line.missing === 0;
    const cost = !ok && unit != null ? ` · ≈ ${formatMoney(unit * line.missing, state.currency)}` : '';
    info.append(el('span', `own ${ok ? 'own-ok' : 'own-missing'}`, `Possédé ${line.have}/${line.need}${ok ? '' : ` · il en manque ${line.missing}${cost}`}`));
  }

  const actions = el('div', 'card-actions');
  if (isOwner()) {
    const plusCheck = canAdd(state.deck, card, row.zone);
    actions.append(
      stepButton('−', 'Retirer un exemplaire', 'minus', false, () => changeRow(row, -1)),
      el('span', 'qty', String(row.quantity)),
      stepButton('+', plusCheck.ok ? 'Ajouter un exemplaire' : plusCheck.reason, 'plus', !plusCheck.ok, () => changeRow(row, +1)),
    );
    if (!plusCheck.ok) actions.lastChild.title = plusCheck.reason;
  } else {
    actions.append(el('span', 'qty', `×${row.quantity}`));
  }

  const main = el('div', 'card-main');
  if (SHOW_IMAGES) main.append(thumbnail(card));
  main.append(info);
  li.append(main, actions);
  return li;
}

// ---------- Prix ----------

function setPriceNote(message, isError = false) {
  ui.priceNote.textContent = message;
  ui.priceNote.classList.toggle('is-error', isError);
}

function priceInfo(cards) {
  const supported = cards.filter((c) => supportsPrices(c.game));
  if (!supported.length) return `Pas de prix pour ${gameLabel(state.deck.game)}`;
  const date = latestUpdate(supported, state.prices);
  const { source, label } = CURRENCIES[state.currency];
  return `Prix ${source} (${label})${date ? ` · mis à jour le ${date}` : ''}`;
}

let priceRun = 0;

// Charge les prix déjà connus, puis redemande aux API ceux de plus de 24 h (sans bloquer l'affichage)
async function ensurePrices() {
  const deck = state.deck;
  if (!deck) return;
  const run = ++priceRun;
  const cards = deck.cards.map((r) => r.card);
  const priced = cards.filter((c) => c.id && supportsPrices(c.game));
  state.pricesReady = false;

  if (!cards.length) {
    setPriceNote('');
    return;
  }
  if (!priced.length) {
    state.pricesReady = true;
    setPriceNote(priceInfo(cards));
    return;
  }
  try {
    const known = await loadPrices(priced.map((c) => c.id));
    for (const [id, entry] of known) state.prices.set(id, entry);
    if (run !== priceRun || state.deck?.id !== deck.id) return;
    renderDeck();

    await refreshPrices(priced, state.prices, {
      onProgress: (message) => run === priceRun && setPriceNote(message),
    });
    if (run !== priceRun || state.deck?.id !== deck.id) return;
    state.pricesReady = true;
    setPriceNote(priceInfo(cards));
    renderDeck();
  } catch (err) {
    console.error(err);
    if (run === priceRun) setPriceNote(friendlyError(err), true);
  }
}

// « ≈ 4,20 € » : prix d'une carte dans la devise choisie
const moneyOf = (card) => {
  if (!supportsPrices(card.game)) return null;
  const unit = unitPrice(state.prices.get(card.id), state.currency);
  return unit == null ? null : unit;
};

// Coût des cartes qui manquent (au prix de chaque carte)
function missingCost(missing) {
  let cost = 0;
  let unpriced = 0;
  for (const line of missing.lines) {
    if (!line.missing) continue;
    const unit = moneyOf(line.card);
    if (unit == null) unpriced += 1;
    else cost += unit * line.missing;
  }
  return { cost, unpriced };
}

// ---------- Modifier les cartes du deck ----------

async function writeQuantity(row, quantity) {
  const { error } = await supabase.from('deck_cards').update({ quantity }).eq('id', row.id);
  if (error) throw error;
  row.quantity = quantity;
}

async function changeRow(row, delta) {
  const deck = state.deck;
  if (!deck || !isOwner()) return;

  if (delta > 0) {
    const check = canAdd(deck, row.card, row.zone);
    if (!check.ok) {
      setDeckMsg(check.reason, true);
      return;
    }
  }
  const action = delta > 0 ? 'plus' : 'minus';
  try {
    if (delta > 0 || row.quantity > 1) {
      await writeQuantity(row, row.quantity + delta);
    } else {
      const { error } = await supabase.from('deck_cards').delete().eq('id', row.id);
      if (error) throw error;
      deck.cards = deck.cards.filter((r) => r.id !== row.id);
    }
    setDeckMsg('');
  } catch (err) {
    console.error(err);
    setDeckMsg(friendlyError(err), true);
    return;
  }
  renderDeck();
  document.querySelector(`.deck-row[data-id="${CSS.escape(row.id)}"] [data-action="${action}"]`)?.focus();
}

async function addCard(card, zoneKey) {
  const deck = state.deck;
  const zone = zonesOf(deck).find((z) => z.key === zoneKey);
  const known = deckCardFor(card) ?? card;
  const pre = canAdd(deck, known, zoneKey);
  if (!pre.ok) {
    setAddMsg(pre.reason, true);
    return;
  }
  setAddMsg('Ajout en cours…');

  try {
    // fiche complète (le jeu peut la compléter) : les règles sont revérifiées avec elle
    const stored = await ensureCard(card);
    if (state.deck?.id !== deck.id) return;
    const check = canAdd(state.deck, stored, zoneKey);
    if (!check.ok) {
      setAddMsg(check.reason, true);
      return;
    }

    const existing = state.deck.cards.find((r) => r.card.id === stored.id && r.zone === zoneKey);
    if (existing) {
      await writeQuantity(existing, existing.quantity + 1);
    } else {
      const { data, error } = await supabase
        .from('deck_cards')
        .insert({ deck_id: deck.id, card_id: stored.id, zone: zoneKey, quantity: 1 })
        .select('id, quantity')
        .single();
      if (error) throw error;
      state.deck.cards.push({ id: data.id, zone: zoneKey, quantity: data.quantity, card: stored });
    }
    const index = state.results.findIndex((c) => keyOf(c) === keyOf(card));
    if (index !== -1) state.results[index] = stored;
    for (const li of ui.results.children) if (li.__card && keyOf(li.__card) === keyOf(card)) li.__card = stored;

    setAddMsg(`« ${stored.name} » ajoutée à « ${zone.label} ».`);
    renderDeck();
    ensurePrices();
  } catch (err) {
    console.error(err);
    setAddMsg(friendlyError(err), true);
  } finally {
    if (state.deck?.id === deck.id) refreshResultActions();
  }
}

// la fiche complète d'une carte déjà présente dans le deck (règles plus précises)
const deckCardFor = (card) => state.deck?.cards.find((r) => keyOf(r.card) === keyOf(card))?.card ?? null;

// ---------- Infos du deck (nom, description, format, publication) ----------

async function saveDeck(patch) {
  const { error } = await supabase.from('decks').update(patch).eq('id', state.deck.id);
  if (error) throw error;
  Object.assign(state.deck, patch, { updated_at: new Date().toISOString() });
  updateDeckSub();
}

async function onNameChange() {
  const name = ui.deckName.value.trim();
  if (!name) {
    ui.deckName.value = state.deck.name;
    setDeckMsg('Le nom du deck ne peut pas être vide.', true);
    return;
  }
  if (name === state.deck.name) return;
  try {
    await saveDeck({ name: name.slice(0, 80) });
    setDeckMsg('');
  } catch (err) {
    console.error(err);
    ui.deckName.value = state.deck.name;
    setDeckMsg(friendlyError(err), true);
  }
}

async function onDescChange() {
  const description = ui.deckDesc.value.trim();
  if (description === (state.deck.description ?? '')) return;
  try {
    await saveDeck({ description: description || null });
    setDeckMsg('');
  } catch (err) {
    console.error(err);
    ui.deckDesc.value = state.deck.description ?? '';
    setDeckMsg(friendlyError(err), true);
  }
}

async function onFormatChange() {
  const format = ui.deckFormat.value;
  if (format === state.deck.format) return;
  try {
    await saveDeck({ format });
    setDeckMsg('Format modifié : les règles du deck sont recalculées.');
    renderDeck();
    if (isOwner()) prepareSearchPanel();
  } catch (err) {
    console.error(err);
    ui.deckFormat.value = state.deck.format ?? rulesFor(state.deck.game).defaultFormat;
    setDeckMsg(friendlyError(err), true);
  }
}

async function onPublicChange() {
  const wanted = ui.deckPublic.checked;
  try {
    await saveDeck({ is_public: wanted });
    ui.copyLink.hidden = !wanted;
    setDeckMsg(
      wanted
        ? 'Deck publié : tous les utilisateurs connectés peuvent le consulter et le copier.'
        : 'Deck repassé en privé : toi seul peux le voir.',
    );
  } catch (err) {
    console.error(err);
    ui.deckPublic.checked = !wanted;
    setDeckMsg(friendlyError(err), true);
  }
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}#${state.deck.id}`;
  try {
    await navigator.clipboard.writeText(url);
    setDeckMsg('Lien copié. Les utilisateurs connectés pourront ouvrir ce deck.');
  } catch {
    setDeckMsg(`Copie ce lien : ${url}`);
  }
}

async function copyDeck() {
  const source = state.deck;
  ui.copyDeck.disabled = true;
  try {
    const { data: created, error } = await supabase
      .from('decks')
      .insert({
        game: source.game,
        format: source.format,
        name: `${source.name} (copie)`.slice(0, 80),
        description: source.description,
        is_public: false,
      })
      .select('id')
      .single();
    if (error) throw error;

    const rows = source.cards.map((r) => ({ deck_id: created.id, card_id: r.card.id, zone: r.zone, quantity: r.quantity }));
    if (rows.length) {
      const { error: cardsError } = await supabase.from('deck_cards').insert(rows);
      if (cardsError) {
        await supabase.from('decks').delete().eq('id', created.id); // on ne laisse pas un deck à moitié copié
        throw cardsError;
      }
    }
    location.hash = `#${created.id}`;
  } catch (err) {
    console.error(err);
    setDeckMsg(friendlyError(err), true);
  } finally {
    ui.copyDeck.disabled = false;
  }
}

async function deleteDeck() {
  if (!confirm(`Supprimer définitivement le deck « ${state.deck.name} » ?`)) return;
  const { error } = await supabase.from('decks').delete().eq('id', state.deck.id);
  if (error) {
    console.error(error);
    setDeckMsg(friendlyError(error), true);
    return;
  }
  location.hash = '';
}

// ---------- Cartes manquantes -> wishlist ----------

async function addMissingToWishlist() {
  const missing = missingCards(state.deck, state.owned, { ignoreBasics: state.ignoreBasics });
  const lines = missing.lines.filter((l) => l.missing > 0 && l.card.id);
  if (!lines.length) return;

  ui.missingWish.disabled = true;
  try {
    // on garde la quantité déjà souhaitée si elle est plus grande
    const existing = new Map();
    const ids = lines.map((l) => l.card.id);
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await supabase
        .from('wishlist_items')
        .select('card_id, quantity')
        .eq('user_id', state.userId)
        .in('card_id', ids.slice(i, i + 100));
      if (error) throw error;
      for (const r of data ?? []) existing.set(r.card_id, r.quantity);
    }
    const rows = lines.map((l) => ({
      user_id: state.userId,
      card_id: l.card.id,
      quantity: Math.min(999, Math.max(l.missing, existing.get(l.card.id) ?? 0)),
    }));
    const { error } = await supabase.from('wishlist_items').upsert(rows, { onConflict: 'user_id,card_id' });
    if (error) throw error;
    setDeckMsg(`${plural(rows.length, 'carte')} ajoutée${rows.length > 1 ? 's' : ''} à ta wishlist.`);
  } catch (err) {
    console.error(err);
    setDeckMsg(friendlyError(err), true);
  } finally {
    ui.missingWish.disabled = false;
  }
}

// =====================================================================
// RECHERCHE DE CARTES (onglet « Ajouter »)
// =====================================================================

function setDeckTab(tab) {
  state.tab = tab === 'add' && isOwner() ? 'add' : 'deck';
  ui.dtabDeck.setAttribute('aria-pressed', String(state.tab === 'deck'));
  ui.dtabAdd.setAttribute('aria-pressed', String(state.tab === 'add'));
  ui.panelDeck.hidden = state.tab !== 'deck';
  ui.panelAdd.hidden = state.tab !== 'add';
  if (state.tab === 'add') refreshResultActions();
}

function fillTypeSelect(provider) {
  const keep = ui.type.value;
  ui.type.replaceChildren(new Option('Tous types', ''));
  const sections = new Map();
  for (const group of provider.typeGroups) {
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
  ui.type.value = provider.typeGroups.some((g) => g.key === keep) ? keep : '';
}

function applyModeUi(provider) {
  const byId = ui.mode.value === 'id';
  ui.textLabel.textContent = byId ? provider.idLabel : 'Nom de la carte';
  ui.text.placeholder = byId ? provider.idPlaceholder : provider.namePlaceholder;
  ui.text.inputMode = byId ? provider.idInputMode ?? 'text' : 'text';
}

function prepareSearchPanel() {
  const provider = getGame(state.deck.game)?.provider;
  if (!provider) return;
  const ready = provider.init?.();
  const deckId = state.deck.id;
  fillTypeSelect(provider);
  if (ready?.then) {
    ready
      .then(() => {
        if (state.deck?.id === deckId) fillTypeSelect(provider);
      })
      .catch((err) => console.warn('Initialisation du jeu :', err));
  }
  ui.mode.options[1].textContent = provider.idLabel;
  ui.mode.value = 'name';
  ui.text.value = '';
  ui.type.value = '';
  applyModeUi(provider);
  ui.results.replaceChildren();
  ui.more.hidden = true;
  setAddMsg('Cherche une carte par nom, par code ou par type pour l\'ajouter au deck.');
}

async function runSearch({ more = false } = {}) {
  const provider = getGame(state.deck.game)?.provider;
  const query = more ? state.search.query : { mode: ui.mode.value, text: ui.text.value, type: ui.type.value };
  const problem = provider.validate(query);
  if (problem) {
    setAddMsg(problem, true);
    return;
  }

  const token = ++state.token;
  const deckId = state.deck.id;
  ui.searchBtn.disabled = true;
  ui.more.disabled = true;
  setAddMsg('Recherche en cours…');

  try {
    const res = await provider.search({
      ...query,
      offset: more ? state.search.offset : 0,
      lang: more ? state.search.lang : null,
      onProgress: (message) => token === state.token && setAddMsg(message),
    });
    if (token !== state.token || state.deck?.id !== deckId) return;

    state.results = more ? [...state.results, ...res.cards] : res.cards;
    state.search = { offset: res.nextOffset, lang: res.lang, hasMore: res.hasMore, total: res.total, done: true, query };
    fillTypeSelect(provider);
  } catch (err) {
    if (token !== state.token) return;
    console.error(err);
    setAddMsg('Impossible de joindre la base de cartes. Réessaie dans un instant.', true);
    return;
  } finally {
    if (token === state.token) {
      ui.searchBtn.disabled = false;
      ui.more.disabled = false;
    }
  }
  renderResults();
}

function renderResults() {
  images.resetObserver();
  ui.results.replaceChildren();
  ui.more.hidden = true;

  if (!state.results.length) {
    setAddMsg(
      state.search.done
        ? "Aucune carte trouvée. Essaie un autre nom (le français et l'anglais fonctionnent)."
        : "Cherche une carte par nom, par code ou par type pour l'ajouter au deck.",
    );
    return;
  }
  const { total, hasMore } = state.search;
  setAddMsg(
    total == null
      ? `${plural(state.results.length, 'résultat')}${hasMore ? " (il y en a d'autres)" : ''}`
      : `${state.results.length} sur ${plural(total, 'résultat')}`,
  );
  for (const card of state.results) ui.results.append(resultRow(card));
  refreshResultActions();
  ui.more.hidden = !state.search.hasMore;
}

function resultRow(card) {
  const li = el('li', 'card-row result-row');
  li.__card = card;

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', card.name));
  info.append(el('span', 'card-meta', providerOf(card)?.metaLine?.(card) ?? ''));
  info.append(el('span', 'deny'));

  const main = el('div', 'card-main');
  if (SHOW_IMAGES) main.append(thumbnail(card));
  main.append(info);

  li.append(main, el('div', 'card-actions'));
  return li;
}

// Boutons d'ajout de chaque résultat : grisés quand la règle l'interdit
function refreshResultActions() {
  const deck = state.deck;
  if (!deck || !isOwner()) return;

  for (const li of ui.results.children) {
    const card = li.__card;
    if (!card) continue;
    const known = deckCardFor(card) ?? card;
    const zones = zonesOf(deck);
    const keys = [autoZone(deck, known), ...alternativeZones(deck, known)].filter(Boolean);

    const actions = el('div', 'card-actions');
    const deny = li.querySelector('.deny');
    deny.textContent = '';

    const inDeck = deck.cards.filter((r) => keyOf(r.card) === keyOf(card)).reduce((sum, r) => sum + r.quantity, 0);
    if (inDeck) actions.append(el('span', 'badge', `Dans le deck ×${inDeck}`));

    if (!keys.length) {
      deny.textContent = 'Cette carte ne peut pas être ajoutée à ce deck.';
    }
    keys.forEach((zoneKey, i) => {
      const zone = zones.find((z) => z.key === zoneKey);
      const check = canAdd(deck, known, zoneKey);
      const button = el('button', i === 0 ? 'btn-small' : 'btn-outline-small', `+ ${zone.short}`);
      button.type = 'button';
      button.dataset.action = `add-${zoneKey}`;
      button.disabled = !check.ok;
      button.title = check.ok ? `Ajouter à « ${zone.label} »` : check.reason;
      button.addEventListener('click', () => addCard(li.__card, zoneKey));
      actions.append(button);
      if (!check.ok && i === 0) deny.textContent = check.reason;
    });
    li.querySelector(':scope > .card-actions').replaceWith(actions);
  }
}

// =====================================================================
// ÉVÉNEMENTS ET DÉMARRAGE
// =====================================================================

function bindEvents() {
  ui.tabMine.addEventListener('click', () => setListTab('mine'));
  ui.tabPublic.addEventListener('click', () => setListTab('public'));
  ui.listText.addEventListener('input', renderList);
  ui.author.addEventListener('change', renderList);
  ui.listForm.addEventListener('submit', (e) => e.preventDefault());
  ui.newBtn.addEventListener('click', openNewForm);
  ui.newCancel.addEventListener('click', () => {
    ui.newForm.hidden = true;
  });
  ui.newGame.addEventListener('change', fillNewFormats);
  ui.newForm.addEventListener('submit', createDeck);

  ui.back.addEventListener('click', () => {
    location.hash = '';
  });
  ui.deckName.addEventListener('change', onNameChange);
  ui.deckDesc.addEventListener('change', onDescChange);
  ui.deckFormat.addEventListener('change', onFormatChange);
  ui.deckPublic.addEventListener('change', onPublicChange);
  ui.copyLink.addEventListener('click', copyLink);
  ui.copyDeck.addEventListener('click', copyDeck);
  ui.deleteDeck.addEventListener('click', deleteDeck);
  ui.dtabDeck.addEventListener('click', () => setDeckTab('deck'));
  ui.dtabAdd.addEventListener('click', () => setDeckTab('add'));
  ui.ignoreBasics.addEventListener('change', () => {
    state.ignoreBasics = ui.ignoreBasics.checked;
    saveIgnoreBasics(state.ignoreBasics);
    renderDeck();
  });
  ui.missingWish.addEventListener('click', addMissingToWishlist);

  ui.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.deck) runSearch();
  });
  ui.mode.addEventListener('change', () => {
    const provider = getGame(state.deck?.game)?.provider;
    if (provider) applyModeUi(provider);
  });
  ui.more.addEventListener('click', () => runSearch({ more: true }));

  window.addEventListener('hashchange', route);
}

async function start(session) {
  state.userId = session.user.id;
  bindEvents();
  renderGames();
  initCurrencyToggle((currency) => {
    state.currency = currency;
    if (state.deck) {
      renderDeck();
      setPriceNote(priceInfo(state.deck.cards.map((r) => r.card)));
    }
  });
  await revealPage(session);
  await loadNames();
  route();
}

// (en fin de fichier : tout le reste doit être défini avant de s'exécuter)
const session = await bootPage({ version: APP_VERSION, files: ALL_FILES });
if (session) await start(session);
