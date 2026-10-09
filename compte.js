// =====================================================================
// Page « Mon compte » : changer son mot de passe
//
// Sécurité : on demande d'abord l'ANCIEN mot de passe, vérifié auprès de
// Supabase par une vraie connexion ; ce n'est qu'après que le nouveau est
// enregistré. Une fois changé, les autres appareils connectés sont déconnectés.
// =====================================================================

import { supabase } from './config.js';
import { $, bootPage, revealPage, downloadJson, fetchAll, friendlyError, CARD_COLUMNS } from './common.js?v=19';

const APP_VERSION = '19';
const MIN_LENGTH = 8;

const form = $('password-form');
const fields = { current: $('current'), next: $('next'), confirm: $('confirm') };
const message = $('password-msg');
const submit = $('password-submit');

function show(text, kind = 'error') {
  message.textContent = text;
  message.classList.toggle('is-error', kind === 'error');
  message.classList.toggle('is-ok', kind === 'ok');
}

// Message clair pour une erreur renvoyée par Supabase
function explain(error, step) {
  const code = error?.code ?? '';
  if (error?.status === 429 || /rate_limit/i.test(code)) {
    return 'Trop de tentatives. Patiente quelques minutes avant de réessayer.';
  }
  if (step === 'check' && (code === 'invalid_credentials' || error?.status === 400)) {
    return "L'ancien mot de passe est incorrect.";
  }
  if (code === 'same_password') return "Le nouveau mot de passe doit être différent de l'ancien.";
  if (code === 'weak_password') return 'Ce mot de passe est trop faible ou trop courant. Choisis-en un plus long ou plus original.';
  if (code === 'reauthentication_needed' || code === 'session_not_found' || error?.status === 401) {
    return 'Ta session a expiré : déconnecte-toi, reconnecte-toi, puis réessaie.';
  }
  return `Impossible de ${step === 'check' ? 'vérifier ton mot de passe' : 'modifier ton mot de passe'} pour le moment${code ? ` (${code})` : ''}.`;
}

// ---------- Exporter mes donnees (droit d'acces et de portabilite) ----------

async function exportMyData(userId, pseudo) {
  const msg = $('export-msg');
  msg.textContent = '';
  msg.classList.remove('is-error', 'is-ok');
  $('export-data').disabled = true;
  try {
    const [collection, wishlist, decks, deckCards, offersFrom, offersTo] = await Promise.all([
      fetchAll(() =>
        supabase
          .from('collection_items')
          .select(`id, quantity, purchased, purchase_price, purchase_currency, cards!inner(${CARD_COLUMNS})`)
          .eq('user_id', userId),
      ),
      fetchAll(() => supabase.from('wishlist_items').select(`id, quantity, note, cards!inner(${CARD_COLUMNS})`).eq('user_id', userId)),
      fetchAll(() => supabase.from('decks').select('*').eq('user_id', userId)),
      fetchAll(() => supabase.from('deck_cards').select(`id, deck_id, zone, quantity, cards!inner(${CARD_COLUMNS})`)),
      fetchAll(() => supabase.from('offers').select(`*, cards!inner(${CARD_COLUMNS})`).eq('from_user', userId)),
      fetchAll(() => supabase.from('offers').select(`*, cards!inner(${CARD_COLUMNS})`).eq('to_user', userId)),
    ]);

    downloadJson(`mes-donnees-tcg-${new Date().toISOString().slice(0, 10)}.json`, {
      exported_at: new Date().toISOString(),
      compte: { pseudo, id: userId },
      collection: collection.map((r) => ({
        carte: r.cards,
        quantite: r.quantity,
        achetee: r.purchased,
        prix_achat: r.purchase_price,
        devise_achat: r.purchase_currency,
      })),
      wishlist: wishlist.map((r) => ({ carte: r.cards, quantite: r.quantity, note: r.note })),
      decks: decks.map((d) => ({
        ...d,
        cartes: deckCards.filter((c) => c.deck_id === d.id).map((c) => ({ carte: c.cards, zone: c.zone, quantite: c.quantity })),
      })),
      offres_envoyees: offersFrom,
      offres_recues: offersTo,
    });
    msg.classList.add('is-ok');
    msg.textContent = 'Fichier telecharge.';
  } catch (err) {
    console.error(err);
    msg.classList.add('is-error');
    msg.textContent = friendlyError(err);
  } finally {
    $('export-data').disabled = false;
  }
}

// ---------- Supprimer mon compte (droit a l'effacement) ----------

async function deleteMyAccount(session) {
  const msg = $('delete-msg');
  const password = $('delete-password').value;
  msg.classList.remove('is-error');
  msg.textContent = '';
  if (!password) {
    msg.classList.add('is-error');
    msg.textContent = 'Entre ton mot de passe pour confirmer.';
    return;
  }
  if (
    !confirm(
      "Derniere confirmation : ton compte et toutes tes donnees (collection, wishlist, decks, offres) vont etre supprimes definitivement. Continuer ?",
    )
  ) {
    return;
  }

  $('delete-submit').disabled = true;
  try {
    const checked = await supabase.auth.signInWithPassword({ email: session.user.email, password });
    if (checked.error) {
      msg.classList.add('is-error');
      msg.textContent =
        checked.error.code === 'invalid_credentials' || checked.error.status === 400
          ? 'Mot de passe incorrect.'
          : friendlyError(checked.error);
      return;
    }
    const { error } = await supabase.rpc('delete_own_account');
    if (error) {
      msg.classList.add('is-error');
      msg.textContent = friendlyError(error);
      return;
    }
    await supabase.auth.signOut().catch(() => {});
    location.replace('index.html?deleted=1');
  } catch (err) {
    console.error(err);
    msg.classList.add('is-error');
    msg.textContent = friendlyError(err);
  } finally {
    $('delete-submit').disabled = false;
  }
}

async function start(session) {
  const email = session.user.email;
  $('account-username').value = email?.split('@')[0] ?? '';
  await revealPage(session);

  // afficher / masquer les trois champs
  $('show-passwords').addEventListener('change', (event) => {
    for (const input of Object.values(fields)) input.type = event.target.checked ? 'text' : 'password';
  });

  $('export-data').addEventListener('click', () => exportMyData(session.user.id, $('username').textContent));
  $('delete-form').addEventListener('submit', (event) => {
    event.preventDefault();
    deleteMyAccount(session);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    show('');

    const current = fields.current.value;
    const next = fields.next.value;
    const again = fields.confirm.value;

    if (!current || !next || !again) return show('Remplis les trois champs.');
    if (next.length < MIN_LENGTH) return show(`Le nouveau mot de passe doit faire au moins ${MIN_LENGTH} caractères.`);
    if (next !== again) return show('Les deux nouveaux mots de passe ne sont pas identiques.');
    if (next === current) return show("Le nouveau mot de passe doit être différent de l'ancien.");

    submit.disabled = true;
    try {
      // 1) l'ancien mot de passe doit être le bon
      const checked = await supabase.auth.signInWithPassword({ email, password: current });
      if (checked.error) {
        fields.current.focus();
        return show(explain(checked.error, 'check'));
      }

      // 2) enregistrement du nouveau
      const { error } = await supabase.auth.updateUser({ password: next, current_password: current });
      if (error) return show(explain(error, 'update'));

      // 3) les autres appareils connectés doivent se reconnecter (facultatif)
      let others = true;
      try {
        const { error: outError } = await supabase.auth.signOut({ scope: 'others' });
        others = !outError;
      } catch {
        others = false;
      }

      form.reset();
      $('show-passwords').checked = false;
      for (const input of Object.values(fields)) input.type = 'password';
      show(
        `Mot de passe modifié. Utilise-le à ta prochaine connexion.${others ? ' Tes autres appareils ont été déconnectés.' : ''}`,
        'ok',
      );
    } catch (err) {
      console.error(err);
      show('Une erreur est survenue. Vérifie ta connexion internet et réessaie.');
    } finally {
      submit.disabled = false;
    }
  });
}

// (en fin de fichier : tout le reste doit être défini avant de s'exécuter)
const session = await bootPage({ version: APP_VERSION, files: 'compte.html, compte.js, common.js et config.js' });
if (session) await start(session);
