// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, SCENE_TRIGGERS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, and the version set by hand to 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-nest-protect:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['security']);
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
  }
});

test('the docs: never tested, unofficial, fragile, and in bold: not a certified alarm system', () => {
  const rules = {
    en: [
      /\*\*[^*]*not a certified alarm system[^*]*\*\*/i,
      /never[\s>]+tested[\s>]+with[\s>]+a[\s>]+real/i,
      /unofficial[\s>]+API/i,
      /not[\s>]+affiliated[\s>]+with/i,
      /fragile/i,
      /safety of (people|anyone)/i,
    ],
    fr: [
      /\*\*[^*]*pas un système d'alarme certifié[^*]*\*\*/i,
      /jamais[\s>]+testée[\s>]+avec[\s>]+un[\s>]+vrai/i,
      /API[\s>]+non[\s>]+officielle/i,
      /sans[\s>]+lien[\s>]+avec/i,
      /fragile/i,
      /sécurité des personnes/i,
    ],
  };
  for (const [lang, patterns] of Object.entries(rules)) {
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    for (const pattern of patterns) {
      assert.match(docs, pattern, `docs/${lang}.md`);
    }
    assert.doesNotMatch(docs, /chiffr|encrypt/i, 'a secret field is not encrypted by Gladys');
  }
  assert.match(read('README.md'), /\*\*[^*]*not a certified alarm system/i);
  assert.doesNotMatch(read('gladys-assistant-integration.json'), /chiffr|encrypt/i);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; the credentials are secret fields', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  for (const key of ['issue_token', 'cookies']) {
    assert.equal(fields[key].type, 'secret', `${key} is never sent back to the browser`);
    assert.equal(fields[key].required, true);
  }
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(
      intro.description[lang],
      /NOT A CERTIFIED ALARM SYSTEM|PAS UN SYSTÈME D'ALARME CERTIFIÉ/,
    );
  }
  assert.ok(intro.links.length <= 5 && intro.links.every((l) => l.url.startsWith('https://')));
});

test('the action is the one of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
});

test('the scene triggers: keys, the device filter, and exactly the data the app sends', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  for (const trigger of manifest.scene_triggers) {
    assert.deepEqual(
      trigger.fields.map((f) => [f.key, f.type, f.source]),
      [
        ['device', 'select', 'devices'],
        ['level', 'select', undefined],
      ],
    );
    assert.deepEqual(
      trigger.fields[1].options.map((o) => o.value),
      ['testing', 'warning', 'emergency'],
    );
    assert.deepEqual(
      trigger.variables.map((v) => [v.key, v.type]),
      [
        ['level', 'string'],
        ['room', 'string'],
        ['delayed', 'boolean'],
      ],
    );
  }
  // The event data of src/app.js: device, level, room.
  assert.match(
    app,
    /device: deviceIds\(this\.gladys, detector\.id\)\.device,\s+level: .*,\s+room: /,
  );
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
});
