// =====================================================================
// Page « Offres » : les offres reçues (à accepter ou refuser) et envoyées
// (à suivre ou annuler). Le site ne gère aucun paiement : après un accord,
// les deux personnes s'arrangent en privé.
// =====================================================================

import { supabase } from './config.js';
import {
  $, el, providerOf, friendlyError, createImages, bootPage, revealPage, refreshOfferBadge, ALL_FILES, SHOW_IMAGES,
} from './common.js?v=19';
import { loadOffers, answerOffer, markSeen, formatOfferPrice } from './offers.js?v=19';

const APP_VERSION = '19';

const ui = {
  tabReceived: $('tab-received'),
  tabSent: $('tab-sent'),
  countReceived: $('count-received'),
  countSent: $('count-sent'),
  status: $('status'),
  list: $('offer-list'),
};

const state = {
  userId: null,
  tab: 'received',
  received: [],
  sent: [],
  names: new Map(), // id utilisateur -> pseudo
};

const setStatus = (message, isError = false) => {
  ui.status.textContent = message;
  ui.status.classList.toggle('is-error', isError);
};

const images = createImages({
  lightbox: $('lightbox'),
  img: $('lightbox-img'),
  name: $('lightbox-name'),
  meta: $('lightbox-meta'),
  onError: (message) => setStatus(message, true),
});

const nameOf = (userId) => state.names.get(userId) ?? 'un utilisateur';
const dateFr = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR') : '');
const priceOf = (o) => formatOfferPrice(o.price, o.currency);

// L'offre est-elle une nouveauté pour toi ?
const isNew = (o, side) =>
  side === 'received' ? !o.to_seen : !o.from_seen && ['accepted', 'declined'].includes(o.status);

// ---------- Chargement ----------

async function load() {
  setStatus('Chargement des offres…');
  const [received, sent, profiles] = await Promise.all([
    loadOffers('received', state.userId),
    loadOffers('sent', state.userId),
    supabase.from('profiles').select('id, username'),
  ]);
  state.received = received;
  state.sent = sent;
  state.names = new Map((profiles.data ?? []).map((p) => [p.id, p.username]));
  render();
}

// ---------- Affichage ----------

function updateCounts() {
  const pending = state.received.filter((o) => o.status === 'pending').length;
  const answers = state.sent.filter((o) => isNew(o, 'sent')).length;
  ui.countReceived.textContent = pending ? ` (${pending})` : '';
  ui.countSent.textContent = answers ? ` (${answers})` : '';
}

function pill(status, text) {
  return el('span', `offer-pill is-${status}`, text);
}

function offerRow(o, side) {
  const row = el('li', 'card-row offer-row');
  row.dataset.id = o.id;

  const gift = o.kind === 'gift';
  const who = side === 'received' ? nameOf(o.from_user) : nameOf(o.to_user);

  const info = el('div', 'card-info');
  info.append(el('strong', 'card-name', o.card.name));
  info.append(el('span', 'card-meta', providerOf(o.card)?.metaLine?.(o.card) ?? ''));

  const line = el('p', 'offer-line');
  const what = `${o.quantity > 1 ? `×${o.quantity} · ` : ''}${gift ? 'gratuit' : `pour ${priceOf(o)}`}`;
  if (side === 'received') {
    line.append(el('strong', null, who), ` te propose de te ${o.quantity > 1 ? 'les' : 'la'} ${gift ? 'donner' : 'vendre'} — ${what}`);
  } else {
    line.append('Tu proposes à ', el('strong', null, who), ` de ${o.quantity > 1 ? 'les' : 'la'} ${gift ? 'donner' : 'vendre'} — ${what}`);
  }
  info.append(line);
  if (o.message) info.append(el('p', 'offer-message', `« ${o.message} »`));

  const dates = `Envoyée le ${dateFr(o.created_at)}${o.responded_at ? ` · réponse le ${dateFr(o.responded_at)}` : ''}`;
  info.append(el('small', 'offer-date', dates));

  if (o.status === 'accepted') {
    info.append(
      el(
        'p',
        'offer-next',
        side === 'received'
          ? `Contacte ${who} pour vous arranger en privé${gift ? '' : ` (le paiement de ${priceOf(o)} se règle entre vous)`}.`
          : `${who} a accepté : arrangez-vous en privé${gift ? '' : ` (le paiement de ${priceOf(o)} se règle entre vous)`}.`,
      ),
    );
  }

  const actions = el('div', 'card-actions');
  if (isNew(o, side)) actions.append(el('span', 'badge', 'Nouveau'));

  if (o.status === 'pending' && side === 'received') {
    const accept = el('button', 'btn-small', 'Accepter');
    accept.dataset.action = 'accept';
    accept.type = 'button';
    accept.addEventListener('click', () => respond(o, 'accepted', accept));
    const decline = el('button', 'btn-outline-small', 'Refuser');
    decline.dataset.action = 'decline';
    decline.type = 'button';
    decline.addEventListener('click', () => respond(o, 'declined', decline));
    actions.append(accept, decline);
  } else if (o.status === 'pending') {
    actions.append(pill('pending', 'En attente'));
    const cancel = el('button', 'btn-outline-small', "Annuler l'offre");
    cancel.dataset.action = 'cancel';
    cancel.type = 'button';
    cancel.addEventListener('click', () => respond(o, 'cancelled', cancel));
    actions.append(cancel);
  } else {
    const text = {
      accepted: 'Acceptée',
      declined: 'Refusée',
      cancelled: side === 'received' ? `Annulée par ${who}` : 'Annulée',
    }[o.status];
    actions.append(pill(o.status, text));
  }

  const main = el('div', 'card-main');
  if (SHOW_IMAGES) main.append(images.thumbnail(o.card));
  main.append(info);
  row.append(main, actions);
  return row;
}

function render() {
  images.resetObserver();
  ui.tabReceived.setAttribute('aria-pressed', String(state.tab === 'received'));
  ui.tabSent.setAttribute('aria-pressed', String(state.tab === 'sent'));
  updateCounts();

  const offers = state[state.tab];
  ui.list.replaceChildren();
  if (!offers.length) {
    setStatus(
      state.tab === 'received'
        ? "Aucune offre reçue pour l'instant. Quand quelqu'un te propose une carte que tu cherches, elle apparaît ici."
        : "Tu n'as envoyé aucune offre. Dans la Wishlist, onglet « Toutes les wishlists », propose une carte que tu possèdes.",
    );
  } else {
    const waiting = offers.filter((o) => o.status === 'pending').length;
    setStatus(`${offers.length} offre${offers.length > 1 ? 's' : ''}${waiting ? ` · ${waiting} en attente` : ''}`);
  }
  for (const offer of offers) ui.list.append(offerRow(offer, state.tab));

  // ce que tu viens de voir n'est plus « nouveau » pour la pastille du menu
  const unseen = offers.filter((o) => isNew(o, state.tab)).map((o) => o.id);
  if (unseen.length) {
    markSeen(state.tab, unseen)
      .then(() => refreshOfferBadge(state.userId))
      .catch((err) => console.warn('Marquage « vu » impossible', err));
  }
}

// ---------- Réponses ----------

async function respond(offer, status, button) {
  const who = state.tab === 'received' ? nameOf(offer.from_user) : nameOf(offer.to_user);
  const gift = offer.kind === 'gift';
  const question = {
    accepted: gift
      ? `Accepter le don de « ${offer.card.name} » proposé par ${who} ? Vous vous arrangerez en privé.`
      : `Accepter l'offre de ${who} : « ${offer.card.name} » pour ${priceOf(offer)} ? Le paiement se règle en privé entre vous.`,
    declined: `Refuser l'offre de ${who} pour « ${offer.card.name} » ?`,
    cancelled: `Annuler ton offre pour « ${offer.card.name} » à ${who} ?`,
  }[status];
  if (!confirm(question)) return;

  button.disabled = true;
  try {
    await answerOffer(offer.id, status);
    await load();
    await refreshOfferBadge(state.userId);
    setStatus(
      {
        accepted: `Offre acceptée. Contacte ${who} pour vous arranger en privé.`,
        declined: 'Offre refusée.',
        cancelled: 'Offre annulée.',
      }[status],
    );
  } catch (err) {
    console.error(err);
    button.disabled = false;
    setStatus(err?.message?.startsWith("Cette offre n'est") ? err.message : friendlyError(err), true);
  }
}

// ---------- Démarrage ----------

async function start(session) {
  state.userId = session.user.id;
  ui.tabReceived.addEventListener('click', () => {
    state.tab = 'received';
    render();
  });
  ui.tabSent.addEventListener('click', () => {
    state.tab = 'sent';
    render();
  });
  await revealPage(session);
  try {
    await load();
  } catch (err) {
    console.error(err);
    setStatus(friendlyError(err), true);
  }
}

// (en fin de fichier : tout le reste doit être défini avant de s'exécuter)
const session = await bootPage({ version: APP_VERSION, files: ALL_FILES });
if (session) await start(session);
