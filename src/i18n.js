// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, feature names), in
// English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  smoke: both('Smoke', 'Fumée'),
  co: both('Carbon monoxide (CO)', 'Monoxyde de carbone (CO)'),
  muted: both('Alarm hushed', 'Alarme en sourdine'),
  battery: both('Battery', 'Batterie'),
  battery_low: both('Battery to replace', 'Pile à remplacer'),
  online: both('Online (1 = yes)', 'En ligne (1 = oui)'),
  self_test: both('Self-test passed (1 = yes)', 'Auto-test réussi (1 = oui)'),
  last_test_days: both('Days since the last manual test', 'Jours depuis le dernier test manuel'),
  night_light: both('Night light on (1 = yes)', 'Veilleuse activée (1 = oui)'),
};

/** The device name: "Nest Protect (Kitchen)". */
export const deviceName = (label) => (label ? `Nest Protect (${label})` : 'Nest Protect');

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return { en: `${minutes} min`, fr: `${minutes} min` };
  }
  const hours = Math.round(minutes / 60);
  return { en: `${hours} h`, fr: `${hours} h` };
}

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

const reason = (text) => both(text, text);

export const T = {
  noCredentials: both(
    'Paste the issue_token and the cookies of your Google account (see the guide), then save.',
    "Collez l'issue_token et les cookies de votre compte Google (voir le guide), puis enregistrez.",
  ),
  badIssueToken: both(
    'The issue_token is not the expected address: it must start with https://accounts.google.com/o/oauth2/iframerpc and contain action=issueToken (see the guide). Nothing was sent.',
    "L'issue_token n'est pas l'adresse attendue : elle doit commencer par https://accounts.google.com/o/oauth2/iframerpc et contenir action=issueToken (voir le guide). Rien n'a été envoyé.",
  ),
  badCookies: both(
    'The cookies do not look like those of a signed-in Google account (the whole "cookie" header is needed, see the guide). Nothing was sent.',
    "Les cookies ne ressemblent pas à ceux d'un compte Google connecté (il faut tout l'en-tête « cookie », voir le guide). Rien n'a été envoyé.",
  ),
  connecting: both('Connecting to Nest…', 'Connexion à Nest…'),
  connected: (count) =>
    both(
      `Connected to Nest: ${count} Nest Protect. Open Discovery to add them. Updates arrive as Nest sends them. Not a certified alarm system.`,
      `Connecté à Nest : ${count} Nest Protect. Ouvrez Découverte pour les ajouter. Les mises à jour arrivent quand Nest les envoie. Ce n'est pas un système d'alarme certifié.`,
    ),
  refused: both(
    'Google refused the cookies (signed out of the browser, password changed, or expired): get a new issue_token and new cookies (see the guide), then save. The integration waits for a change (or the test button).',
    "Google a refusé les cookies (déconnexion du navigateur, mot de passe changé, ou expiration) : récupérez un nouvel issue_token et de nouveaux cookies (voir le guide), puis enregistrez. L'intégration attend une modification (ou le bouton de test).",
  ),
  sessionRefused: (wait) =>
    both(
      `Nest refused the session it had just given: one new try in ${wait.en} (or click "Test the connection").`,
      `Nest a refusé la session qu'il venait de donner : un nouvel essai dans ${wait.fr} (ou cliquez sur « Tester la connexion »).`,
    ),
  rateLimited: (wait) =>
    both(
      `Nest asks to slow down (429): paused for ${wait.en}.`,
      `Nest demande de ralentir (429) : pause de ${wait.fr}.`,
    ),
  unreachable: (why, wait) =>
    both(
      `Nest unreachable (${why}): new try in ${wait.en}. The detectors' states shown may be old.`,
      `Nest injoignable (${why}) : nouvel essai dans ${wait.fr}. Les états affichés des détecteurs peuvent être anciens.`,
    ),
  busy: both(
    'A connection is in progress, try again in a moment.',
    'Une connexion est en cours, réessayez dans un instant.',
  ),
  cooldown: both('Tested less than 30 seconds ago.', 'Testé il y a moins de 30 secondes.'),
  reason,
};
