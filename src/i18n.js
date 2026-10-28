// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a secret nor a byte the panel sent, except what was checked by
// pattern: the serial of the panel (src/config.js ID), its model and firmware
// (cleaned, bounded), certificate fingerprints (hex), circuit names (cleaned,
// bounded) and our own words.
// -----------------------------------------------------------------------------

import { shownFingerprint } from './store.js';

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
export const delay = (ms) => {
  const s = Math.round(ms / 1000);
  if (s >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

export const both = (list) => {
  const parts = list.filter((n) => n && n.en);
  return { en: parts.map((n) => n.en).join(' '), fr: parts.map((n) => n.fr).join(' ') };
};

/** Our words for a network, TLS or broker failure (src/span/tls.js, src/span/mqtt.js). */
const REASON = {
  untrusted: {
    en: 'the certificate presented is not signed by the pinned certificate authority',
    fr: 'le certificat présenté n’est pas signé par l’autorité de certification épinglée',
  },
  certificateDate: {
    en: 'the certificate of the panel is expired or not valid yet (is the clock of the panel right?)',
    fr: 'le certificat du panneau est expiré ou pas encore valide (l’horloge du panneau est-elle juste ?)',
  },
  refusedPort: { en: 'connection refused', fr: 'connexion refusée' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  notFound: { en: 'unknown host name', fr: 'nom d’hôte inconnu' },
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  reset: { en: 'connection cut', fr: 'connexion coupée' },
  tls: { en: 'TLS error', fr: 'erreur TLS' },
  network: { en: 'network error', fr: 'erreur réseau' },
  tooLarge: {
    en: 'the panel sent a message too large: connection cut',
    fr: 'le panneau a envoyé un message trop grand : connexion coupée',
  },
  noConnack: {
    en: 'the broker of the panel did not answer the connection',
    fr: 'le broker du panneau n’a pas répondu à la connexion',
  },
  unanswered: {
    en: 'the broker of the panel closed the connection without answering',
    fr: 'le broker du panneau a fermé la connexion sans répondre',
  },
  protocol: { en: 'MQTT version refused', fr: 'version MQTT refusée' },
  identifier: { en: 'client identifier refused', fr: 'identifiant de client refusé' },
  serverUnavailable: { en: 'broker unavailable', fr: 'broker indisponible' },
  credentials: { en: 'credentials refused', fr: 'identifiants refusés' },
  notAuthorized: { en: 'not authorized', fr: 'non autorisé' },
  notSpan: {
    en: 'the answer is not the one of a SPAN panel (is it the right address?)',
    fr: 'la réponse n’est pas celle d’un panneau SPAN (est-ce la bonne adresse ?)',
  },
  badCa: {
    en: 'the panel did not give a readable certificate authority',
    fr: 'le panneau n’a pas donné d’autorité de certification lisible',
  },
  busy: {
    en: 'the panel asks to wait (too many requests)',
    fr: 'le panneau demande d’attendre (trop de requêtes)',
  },
};
export const reason = (code) => REASON[code] ?? REASON.network;

const fp = (hex) => shownFingerprint(hex);
const kwh = (value) => Math.round(value * 1000) / 1000;

const PROXIMITY = {
  en: 'open and close the door of the panel three times, then click within a minute or two',
  fr: 'ouvrez et fermez trois fois la porte du panneau, puis cliquez dans la minute ou les deux qui suivent',
};

const heldLine = ({ label, direction, from, to }) =>
  direction === 'down'
    ? {
        en: `Counter "${label.en}": dropped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `Compteur « ${label.fr} » : baisse de ${kwh(from)} à ${kwh(to)} kWh, retenue (la dernière valeur acceptée est renvoyée).`,
      }
    : {
        en: `Counter "${label.en}": jumped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `Compteur « ${label.fr} » : saut de ${kwh(from)} à ${kwh(to)} kWh, retenu (la dernière valeur acceptée est renvoyée).`,
      };

export const T = {
  problem: {
    noHost: {
      en: 'Enter the address of the SPAN panel (IP address or host name), then click "Pair with the panel".',
      fr: 'Saisissez l’adresse du panneau SPAN (adresse IP ou nom d’hôte), puis cliquez sur « Appairer le panneau ».',
    },
    badHost: {
      en: 'The address is not valid: enter an IP address or a host name only (no http://, no port, no path).',
      fr: 'L’adresse n’est pas valide : saisissez seulement une adresse IP ou un nom d’hôte (sans http://, sans port, sans chemin).',
    },
    badPassphrase: {
      en: 'The passphrase is not valid (at most 256 bytes, no control character).',
      fr: 'La phrase secrète n’est pas valide (256 octets au plus, sans caractère de contrôle).',
    },
    badFingerprint: {
      en: 'The fingerprint is not valid: 64 hexadecimal digits (colons allowed), or leave it empty.',
      fr: 'L’empreinte n’est pas valide : 64 chiffres hexadécimaux (deux-points permis), ou laissez-la vide.',
    },
  },
  configRetry: (wait) => ({
    en: `The configuration could not be read from Gladys: new try in ${delay(wait).en}.`,
    fr: `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${delay(wait).fr}.`,
  }),
  notPaired: {
    en: 'Not paired yet: click "Pair with the panel" (with the passphrase of the panel, or by proximity: leave the passphrase empty and open and close the door of the panel three times first).',
    fr: 'Pas encore appairé : cliquez sur « Appairer le panneau » (avec la phrase secrète du panneau, ou par proximité : laissez la phrase secrète vide et ouvrez et fermez d’abord trois fois la porte du panneau).',
  },
  storeUnreadable: {
    en: 'The file of the integration in /data cannot be read: it is left as it is, and nothing connects until it can be read again (restart the integration).',
    fr: 'Le fichier de l’intégration dans /data est illisible : il est laissé tel quel, et rien ne se connecte tant qu’il ne peut pas être relu (redémarrez l’intégration).',
  },
  connecting: (host) => ({
    en: `Connecting to the SPAN panel at ${host}…`,
    fr: `Connexion au panneau SPAN à ${host}…`,
  }),
  unansweredStop: {
    en: 'The broker of the panel closed the connection twice without answering (a panel restarting, or another service at this address): automatic tries stopped. Click "Test the connection" (one try per click) or save the configuration to try again; pair again if it goes on.',
    fr: 'Le broker du panneau a fermé deux fois la connexion sans répondre (un panneau qui redémarre, ou un autre service à cette adresse) : essais automatiques arrêtés. Cliquez sur « Tester la connexion » (un essai par clic) ou enregistrez la configuration pour réessayer ; appairez de nouveau si cela continue.',
  },
  pinNotSaved: {
    en: 'The certificate authority of the fingerprint typed could not be kept in /data: it is not pinned and nothing connects. Save the configuration again (or restart the integration).',
    fr: 'L’autorité de certification de l’empreinte saisie n’a pas pu être gardée dans /data : elle n’est pas épinglée et rien ne se connecte. Enregistrez de nouveau la configuration (ou redémarrez l’intégration).',
  },
  stale: (ms) => ({
    en: `The panel has sent nothing for ${delay(ms).en}: its values are no longer published as current.`,
    fr: `Le panneau n’a rien envoyé depuis ${delay(ms).fr} : ses valeurs ne sont plus publiées comme actuelles.`,
  }),
  refused: {
    en: 'The broker of the panel refuses the credentials of the pairing: click "Pair with the panel" again. No automatic new try until then.',
    fr: 'Le broker du panneau refuse les identifiants de l’appairage : cliquez de nouveau sur « Appairer le panneau ». Aucun nouvel essai automatique d’ici là.',
  },
  failing: (host, code, wait) => ({
    en: `The SPAN panel at ${host} cannot be reached (${reason(code).en}): new try in ${delay(wait).en}.`,
    fr: `Le panneau SPAN à ${host} ne peut pas être joint (${reason(code).fr}) : nouvel essai dans ${delay(wait).fr}.`,
  }),
  untrusted: (host, pinned, seen, wait) =>
    both([
      {
        en: `The SPAN panel at ${host} presents a certificate the pinned certificate authority (${fp(pinned)}) does not sign: nothing was sent to it.`,
        fr: `Le panneau SPAN à ${host} présente un certificat que l’autorité de certification épinglée (${fp(pinned)}) ne signe pas : rien ne lui a été envoyé.`,
      },
      seen
        ? {
            en: `It now advertises the authority ${fp(seen)}. It is never trusted by itself: if it is really your panel, type this fingerprint in the configuration and save, or empty the fingerprint field, save and click "Pair with the panel" twice.`,
            fr: `Il annonce maintenant l’autorité ${fp(seen)}. Elle n’est jamais adoptée d’elle-même : si c’est bien votre panneau, saisissez cette empreinte dans la configuration et enregistrez, ou videz le champ de l’empreinte, enregistrez et cliquez deux fois sur « Appairer le panneau ».`,
          }
        : { en: '', fr: '' },
      {
        en: `New try in ${delay(wait).en}.`,
        fr: `Nouvel essai dans ${delay(wait).fr}.`,
      },
    ]),
  panel: {
    notDescribed: {
      en: 'Connected to the broker of the panel: waiting for the panel to describe itself.',
      fr: 'Connecté au broker du panneau : en attente de sa description.',
    },
    notPanel: {
      en: 'The device of the serial paired is not a SPAN panel: nothing is published.',
      fr: 'L’appareil du numéro de série appairé n’est pas un panneau SPAN : rien n’est publié.',
    },
    notReady: (state) => ({
      en: `The panel says it is not ready (${state ?? 'no state'}): its values are not published meanwhile.`,
      fr: `Le panneau se dit pas prêt (${state ?? 'pas d’état'}) : ses valeurs ne sont pas publiées entre-temps.`,
    }),
    otherPanel: (paired, seen) => ({
      en: `Another panel (${seen ?? '?'}) answers instead of the one paired (${paired}): nothing is published nor sent. Check the address, or pair again.`,
      fr: `Un autre panneau (${seen ?? '?'}) répond à la place de celui qui est appairé (${paired}) : rien n’est publié ni envoyé. Vérifiez l’adresse, ou appairez de nouveau.`,
    }),
    dataModel: (version) => ({
      en: `The panel publishes the data model ${version ?? '(none: the flat schema of firmware older than r202633)'}: only the data model 1.x of firmware r202633 or later is read. Update the panel (SPAN does it over the air).`,
      fr: `Le panneau publie le modèle de données ${version ?? '(aucun : le schéma plat des firmwares antérieurs à r202633)'} : seul le modèle 1.x des firmwares r202633 ou plus récents est lu. Mettez le panneau à jour (SPAN le fait à distance).`,
    }),
  },
  ok: (panel, notes = []) =>
    both([
      {
        en: `SPAN panel ${panel.serial} connected${panel.model ? ` (${panel.model}` : ''}${panel.firmware ? `, ${panel.firmware}` : ''}${panel.model ? ')' : ''}: ${panel.circuits.length} circuits.`,
        fr: `Panneau SPAN ${panel.serial} connecté${panel.model ? ` (${panel.model}` : ''}${panel.firmware ? `, ${panel.firmware}` : ''}${panel.model ? ')' : ''} : ${panel.circuits.length} circuits.`,
      },
      ...notes,
    ]),
  notes: {
    noDevice: {
      en: 'Create the devices from the "Discover" tab to receive their values.',
      fr: 'Créez les appareils depuis l’onglet « Découverte » pour recevoir leurs valeurs.',
    },
    relayOff: {
      en: 'Circuit relays: read only (the option to open and close them is off).',
      fr: 'Relais des circuits : lecture seule (l’option pour les ouvrir et les fermer est désactivée).',
    },
    relayOn: {
      en: 'Circuit relays: opening and closing allowed from Gladys.',
      fr: 'Relais des circuits : ouverture et fermeture permises depuis Gladys.',
    },
    dropped: (n) => ({
      en: `${n} message(s) of the panel ignored (too large or too many).`,
      fr: `${n} message(s) du panneau ignoré(s) (trop grands ou trop nombreux).`,
    }),
    storeFailed: {
      en: 'The file of the integration in /data cannot be written: the lifetime counters are not sent meanwhile; the other values are.',
      fr: 'Le fichier de l’intégration dans /data ne peut pas être écrit : les compteurs à vie ne sont pas envoyés entre-temps ; les autres valeurs le sont.',
    },
    held: (held) =>
      both([
        ...held.map(heldLine),
        {
          en: 'A drop or a jump is never taken by itself. If the counter was really reset or replaced (or the jump is right), click "Accept the held counter" twice in the configuration of the integration (the first click lists, the second accepts exactly what was listed). Saving the configuration accepts nothing.',
          fr: 'Une baisse ou un saut n’est jamais pris de lui-même. Si le compteur a vraiment été remis à zéro ou remplacé (ou si le saut est juste), cliquez deux fois sur « Accepter le compteur retenu » dans la configuration de l’intégration (le premier clic liste, le second accepte exactement ce qui a été listé). Enregistrer la configuration n’accepte rien.',
        },
      ]),
  },
  pair: {
    running: {
      en: 'A pairing is already running.',
      fr: 'Un appairage est déjà en cours.',
    },
    storeUnreadable: {
      en: 'The file of the integration in /data cannot be read: no pairing until it can be (restart the integration).',
      fr: 'Le fichier de l’intégration dans /data est illisible : pas d’appairage tant qu’il ne peut pas être lu (redémarrez l’intégration).',
    },
    unreachable: (host, code) => ({
      en: `The SPAN panel at ${host} could not be read (${reason(code).en}). Nothing was sent.`,
      fr: `Le panneau SPAN à ${host} n’a pas pu être lu (${reason(code).fr}). Rien n’a été envoyé.`,
    }),
    fingerprintDiffers: (typed, seen) => ({
      en: `The panel advertises the certificate authority ${fp(seen)}, not the fingerprint typed in the configuration (${fp(typed)}): nothing trusted, nothing sent. Check the fingerprint.`,
      fr: `Le panneau annonce l’autorité de certification ${fp(seen)}, pas l’empreinte saisie dans la configuration (${fp(typed)}) : rien d’adopté, rien d’envoyé. Vérifiez l’empreinte.`,
    }),
    confirmPin: (serial, seen, pinned, within, previous) =>
      both([
        previous
          ? {
              en: `Warning: this certificate authority (${fp(seen)}) differs from the one shown at the previous click (${fp(previous)}): something may be answering instead of your panel. Nothing trusted.`,
              fr: `Attention : cette autorité de certification (${fp(seen)}) diffère de celle affichée au clic précédent (${fp(previous)}) : quelque chose répond peut-être à la place de votre panneau. Rien d’adopté.`,
            }
          : undefined,
        pinned
          ? {
              en: `The panel ${serial} now advertises another certificate authority: ${fp(seen)} (pinned until now: ${fp(pinned)}).`,
              fr: `Le panneau ${serial} annonce maintenant une autre autorité de certification : ${fp(seen)} (épinglée jusqu’ici : ${fp(pinned)}).`,
            }
          : {
              en: `The panel ${serial} advertises the certificate authority ${fp(seen)}.`,
              fr: `Le panneau ${serial} annonce l’autorité de certification ${fp(seen)}.`,
            },
        {
          en: `It was read without protection: trust it only if it is your panel (another installation can show it; a device posing as the panel would look exactly like this). Click "Pair with the panel" again, after a few seconds and within ${delay(within).en}, to trust it and pair; or type it in the configuration. Nothing was sent yet.`,
          fr: `Elle a été lue sans protection : ne l’adoptez que si c’est bien votre panneau (une autre installation peut l’afficher ; un appareil qui se ferait passer pour le panneau ressemblerait exactement à ceci). Cliquez de nouveau sur « Appairer le panneau », après quelques secondes et dans les ${delay(within).fr}, pour l’adopter et appairer ; ou saisissez-la dans la configuration. Rien n’a encore été envoyé.`,
        },
      ]),
    notSigned: (host, code) => ({
      en: `The certificate authority advertised does not sign the HTTPS certificate of the panel at ${host} (${reason(code).en}): not trusted, nothing sent.`,
      fr: `L’autorité de certification annoncée ne signe pas le certificat HTTPS du panneau à ${host} (${reason(code).fr}) : non adoptée, rien d’envoyé.`,
    }),
    saveFailed: {
      en: 'The certificate authority could not be kept in /data: nothing was sent. Try again.',
      fr: 'L’autorité de certification n’a pas pu être gardée dans /data : rien n’a été envoyé. Réessayez.',
    },
    refusedPassphrase: {
      en: 'The panel refused the passphrase: check it in the configuration (it is printed on the label of the panel unless it was changed), save, then click again.',
      fr: 'Le panneau a refusé la phrase secrète : vérifiez-la dans la configuration (elle est imprimée sur l’étiquette du panneau sauf si elle a été changée), enregistrez, puis cliquez de nouveau.',
    },
    refusedProximity: {
      en: `The panel did not accept the pairing by proximity: ${PROXIMITY.en}; or type the passphrase of the panel in the configuration.`,
      fr: `Le panneau n’a pas accepté l’appairage par proximité : ${PROXIMITY.fr} ; ou saisissez la phrase secrète du panneau dans la configuration.`,
    },
    unavailable: {
      en: 'The panel cannot read its own passphrase right now and gave no broker password: try again later (SPAN support may help).',
      fr: 'Le panneau ne peut pas lire sa propre phrase secrète en ce moment et n’a pas donné de mot de passe de broker : réessayez plus tard (le support SPAN peut aider).',
    },
    notReady: {
      en: 'The panel is starting and does not accept pairings yet: try again in a minute.',
      fr: 'Le panneau démarre et n’accepte pas encore d’appairage : réessayez dans une minute.',
    },
    badAnswer: {
      en: 'The panel answered the pairing with something unreadable: nothing kept.',
      fr: 'Le panneau a répondu à l’appairage par quelque chose d’illisible : rien de gardé.',
    },
    failed: (host, code) => ({
      en: `The pairing with the panel at ${host} failed (${reason(code).en}): it may or may not have been received; click again.`,
      fr: `L’appairage avec le panneau à ${host} a échoué (${reason(code).fr}) : il a pu être reçu ou non ; cliquez de nouveau.`,
    }),
    otherPanel: (status, registered) => ({
      en: `The panel paired (${registered}) is not the one that answered first (${status}): nothing kept. Check the address.`,
      fr: `Le panneau appairé (${registered}) n’est pas celui qui a répondu d’abord (${status}) : rien de gardé. Vérifiez l’adresse.`,
    }),
    configFailed: {
      en: 'Gladys did not keep the credentials of the pairing: click again.',
      fr: 'Gladys n’a pas gardé les identifiants de l’appairage : cliquez de nouveau.',
    },
    changed: {
      en: 'The configuration changed during the pairing: nothing kept. Click again.',
      fr: 'La configuration a changé pendant l’appairage : rien de gardé. Cliquez de nouveau.',
    },
    done: (serial, proximity) => ({
      en: `Paired with the SPAN panel ${serial}${proximity ? ' (by proximity)' : ''}: connecting. Its devices appear in the "Discover" tab.`,
      fr: `Appairé avec le panneau SPAN ${serial}${proximity ? ' (par proximité)' : ''} : connexion en cours. Ses appareils apparaissent dans l’onglet « Découverte ».`,
    }),
  },
  accept: {
    nothing: {
      en: 'No counter is held back: nothing to accept.',
      fr: 'Aucun compteur n’est retenu : rien à accepter.',
    },
    confirm: (held, within) =>
      both([
        {
          en: 'A second click accepts exactly these values:',
          fr: 'Un second clic accepte exactement ces valeurs :',
        },
        ...held.map((h) =>
          h.direction === 'down'
            ? {
                en: `${h.label.en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (a reset or a replacement: counting goes on from ${kwh(h.to)} kWh, nothing counted for the drop).`,
                fr: `${h.label.fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (remise à zéro ou remplacement : le comptage reprend à ${kwh(h.to)} kWh, rien n’est compté pour la baisse).`,
              }
            : {
                en: `${h.label.en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh counted at once).`,
                fr: `${h.label.fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh comptés d’un coup).`,
              },
        ),
        {
          en: `Click "Accept the held counter" again, after a few seconds and within ${delay(within).en}, to accept them; accept only if this is real.`,
          fr: `Cliquez de nouveau sur « Accepter le compteur retenu », après quelques secondes et dans les ${delay(within).fr}, pour les accepter ; n’acceptez que si c’est réel.`,
        },
      ]),
    done: (accepted, changed, stillHeld) =>
      both([
        ...accepted.map((h) => ({
          en: `Accepted: ${h.label.en} ${kwh(h.to)} kWh, sent at the next publication.`,
          fr: `Accepté : ${h.label.fr} ${kwh(h.to)} kWh, envoyé à la prochaine publication.`,
        })),
        ...(changed.length > 0
          ? [
              {
                en: `Not accepted, the value changed since the first click: ${changed.map((h) => h.label.en).join('; ')}. Click again to list it.`,
                fr: `Non accepté, la valeur a changé depuis le premier clic : ${changed.map((h) => h.label.fr).join(' ; ')}. Cliquez de nouveau pour la lister.`,
              },
            ]
          : []),
        ...(stillHeld
          ? [{ en: 'A different value stays held.', fr: 'Une autre valeur reste retenue.' }]
          : []),
      ]),
  },
  /** The labels of the counters in the texts. */
  counter: {
    feedImport: { en: 'drawn through the main lugs', fr: 'tiré par les bornes principales' },
    feedExport: { en: 'sent back through the main lugs', fr: 'renvoyé par les bornes principales' },
    circuit: (name, produced) => ({
      en: `${name}${produced ? ' (produced)' : ''}`,
      fr: `${name}${produced ? ' (produit)' : ''}`,
    }),
  },
  /** Refusals of a relay command (the thrown message; nothing sent unless said). */
  relay: {
    notCommandable: 'This feature is not a relay of the paired panel: nothing sent.',
    badValue: 'The value must be OPEN or CLOSED: nothing sent.',
    disabled:
      'Opening and closing the circuit relays is off in the configuration of the integration: nothing sent.',
    notConnected: 'The panel is not connected right now: nothing sent.',
    notReady: 'The panel is not ready (or not the one paired): nothing sent.',
    unknownCircuit: 'This circuit is not in the panel right now: nothing sent.',
    notControllable:
      'The panel does not allow commanding the relay of this circuit (always-on or locked): nothing sent.',
    unknownState: 'The state of this relay is not known yet: nothing sent.',
    late: 'The command waited too long behind another one on this circuit: nothing sent.',
    nothingSent:
      'The command could not be sent (connection lost or configuration changed): nothing sent.',
    unconfirmed:
      'Sent, without confirmation: the panel did not publish the new state in time; Gladys shows it as soon as the panel does.',
  },
};
