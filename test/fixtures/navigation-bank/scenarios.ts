// Ground truth for the synthetic navigation bank in `./fs/` (contract v1,
// docs/design/bank-format.md). Each scenario is a question a user could ask
// the retriever plus what a correct answer must contain and which content
// files it must cite. The scenarios check answer content, never the number of
// hops or tool calls. `test/navigation-bank.test.ts` proves offline that every
// path and evidence snippet here is real; it does not run any model.

export type NavigationTheme =
  /** Question and source are in different languages (Russian / English). */
  | 'ru-en'
  /** Question spells a word with `е` where the source has `ё`, or the reverse. */
  | 'yo-e'
  /** Source text is stored decomposed (NFD); it matches the question only after NFC. */
  | 'nfc'
  /** The same abbreviation means different things in different files. */
  | 'ambiguous-abbreviation'
  /** One question asks about several unrelated topics. */
  | 'multi-topic'
  /** One file only points to another file that holds the answer. */
  | 'reference-chain'
  /** The bank does not hold the answer; a correct reply says so. */
  | 'no-answer'
  /** The answer is in the content file only, not in any manifest or the root map. */
  | 'primary-file-only'
  /** The relevant file is a binary with no readable text; its content must not be invented. */
  | 'binary-without-text';

export interface ExpectedFact {
  /** What a correct answer must convey, in English. */
  fact: string;
  /** Bank-relative path of the content file that proves it: the citation a good answer gives. */
  source: string;
  /** Verbatim snippets of `source` (compared after NFC) that carry the fact. */
  evidence: string[];
}

export type ExpectedAnswer =
  /** The bank holds the answer: every fact must be stated, every source cited. */
  | { kind: 'answer'; facts: ExpectedFact[] }
  /**
   * The bank does not hold the answer. A correct reply says so and invents
   * nothing. `absentTerms` are words any invented answer would need; none of
   * them occurs anywhere in the bank (content, manifests, map).
   */
  | { kind: 'not-in-bank'; note: string; absentTerms: string[] }
  /**
   * The relevant file exists but is a binary without readable text. A correct
   * reply cites it, says its content is not available as text, and does not
   * describe it. `facts` are what the bank does say around it.
   */
  | { kind: 'content-unavailable'; unreadable: string; note: string; facts: ExpectedFact[] };

export interface NavigationScenario {
  /** Stable id, kebab-case. */
  id: string;
  themes: NavigationTheme[];
  /** Language the question is written in. */
  language: 'ru' | 'en';
  question: string;
  expected: ExpectedAnswer;
  /**
   * Files that look relevant but must not be used for this answer: a different
   * meaning of the same abbreviation. A citation of one of them is wrong.
   */
  wrongSources?: string[];
  /** Abbreviation shared by `source` and `wrongSources` (theme `ambiguous-abbreviation`). */
  term?: string;
  /** Files that only point to the source (theme `reference-chain`); the evidence is not in them. */
  pointers?: string[];
  /** Spelling pair for theme `yo-e`: how the question spells it vs how the source spells it. */
  spelling?: { question: string; source: string };
}

export const NAVIGATION_SCENARIOS: readonly NavigationScenario[] = [
  {
    id: 'borscht-beets',
    themes: ['ru-en'],
    language: 'en',
    question: 'How long and at what temperature should the beets for the borscht be roasted?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'Beets are roasted whole in foil at 200 °C for 40 minutes',
          source: 'recipes/borscht.md',
          evidence: ['запекать целиком в фольге: 200 °C, 40 минут'],
        },
      ],
    },
  },
  {
    id: 'blini-batter-rest',
    themes: ['ru-en'],
    language: 'en',
    question: 'How long should the blini batter rest before frying?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'The batter rests 30 minutes',
          source: 'recipes/blini.json',
          evidence: ['"rest_minutes": 30', 'Тесто отдыхает 30 минут'],
        },
      ],
    },
  },
  {
    id: 'lisbon-booking-code',
    themes: ['ru-en', 'reference-chain'],
    language: 'ru',
    question: 'Какой код бронирования отеля в Лиссабоне и до какого числа можно бесплатно отменить бронь?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'The hotel booking code is LX7Q-4821',
          source: 'travel/lisbon-2026/hotel-confirmation.html',
          evidence: ['<th>Booking code</th><td>LX7Q-4821</td>'],
        },
        {
          fact: 'Cancellation is free until 2 November 2026',
          source: 'travel/lisbon-2026/hotel-confirmation.html',
          evidence: ['<th>Cancellation</th><td>Free until 2 November 2026</td>'],
        },
      ],
    },
    pointers: ['travel/lisbon-2026/itinerary.md'],
  },
  {
    id: 'hedgehog-food',
    themes: ['yo-e', 'nfc'],
    language: 'ru',
    question: 'Чем кормить ежика осенью и можно ли давать ему молоко?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'Feed unsalted boiled minced chicken or wet cat food',
          source: 'home/garden/hedgehog-feeder.md',
          evidence: ['несолёный варёный куриный фарш или влажный корм для кошек'],
        },
        {
          fact: 'Milk must not be given: it upsets their stomach',
          source: 'home/garden/hedgehog-feeder.md',
          evidence: ['Молоко ежам давать нельзя'],
        },
      ],
    },
    spelling: { question: 'ежика', source: 'ёжика' },
  },
  {
    id: 'pto-balance',
    themes: ['ambiguous-abbreviation'],
    language: 'en',
    question: 'How many PTO days do I have left for 2026?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: '9 PTO (paid time off) days are left for 2026, balance as of 2026-10-01',
          source: 'work/hr/pto-policy-2026.md',
          evidence: ['Balance on 2026-10-01: **9 PTO days** left for 2026.'],
        },
      ],
    },
    term: 'PTO',
    wrongSources: ['home/dacha/tractor-notes.md'],
  },
  {
    id: 'pto-mower-speed',
    themes: ['ambiguous-abbreviation', 'ru-en'],
    language: 'en',
    question: 'At what PTO speed does the mower on the dacha tractor run?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'The mower needs the standard 540 rpm PTO (power take-off) speed',
          source: 'home/dacha/tractor-notes.md',
          evidence: ['540 об/мин'],
        },
      ],
    },
    term: 'PTO',
    wrongSources: ['work/hr/pto-policy-2026.md'],
  },
  {
    id: 'dacha-weekend-and-car-service',
    themes: ['multi-topic', 'ru-en'],
    language: 'ru',
    question: 'Что нужно привезти на дачу на выходные 17–18 октября и на какое число записана машина на ТО?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'Bring a winter cover for the tractor, two cans of antifreeze, 20 leaf bags and new shed locks',
          source: 'home/dacha/autumn-checklist.md',
          evidence: [
            'зимний чехол для трактора',
            'антифриз для системы полива (две канистры)',
            'мешки для листьев, 20 штук',
            'новые замки для сарая',
          ],
        },
        {
          fact: 'The car service is booked for 2026-10-21 (oil change and brake fluid check)',
          source: 'home/car/service-log.csv',
          evidence: ['2026-10-21,,scheduled service: oil change and brake fluid check,booked'],
        },
      ],
    },
  },
  {
    id: 'kestrel-budget',
    themes: ['reference-chain', 'primary-file-only'],
    language: 'en',
    question: 'What is the approved budget for project Kestrel?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'Kestrel has 48 000 EUR approved (budget line K-7, approved on 2026-02-11)',
          source: 'work/finance/budget-2026.csv',
          evidence: ['K-7,Kestrel,mobile app pilot,48000,2026-02-11'],
        },
      ],
    },
    pointers: ['work/projects/kestrel/overview.md'],
  },
  {
    id: 'boiler-pressure',
    themes: ['primary-file-only'],
    language: 'en',
    question: 'What pressure should the boiler show when the system is cold, and what does error F22 mean?',
    expected: {
      kind: 'answer',
      facts: [
        {
          fact: 'Normal cold pressure is 1.2 to 1.5 bar',
          source: 'home/appliances/boiler-manual.txt',
          evidence: ['Normal cold system pressure: 1.2 to 1.5 bar.'],
        },
        {
          fact: 'F22 means low water pressure',
          source: 'home/appliances/boiler-manual.txt',
          evidence: ['Error code F22 means low water pressure.'],
        },
      ],
    },
  },
  {
    id: 'retro-whiteboard',
    themes: ['binary-without-text'],
    language: 'en',
    question: 'What was written on the sticky notes on the whiteboard at the 14 September retro?',
    expected: {
      kind: 'content-unavailable',
      unreadable: 'work/retro/whiteboard-2026-09-14.png',
      note: 'The photo exists but has no text in the bank; the sticky notes must not be described or guessed.',
      facts: [
        {
          fact: 'The whiteboard was photographed and the sticky notes were never transcribed',
          source: 'work/retro/retro-2026-09-14.md',
          evidence: [
            'The whiteboard was photographed at the end of the session: whiteboard-2026-09-14.png in this folder.',
            'Nobody has transcribed the sticky notes from the photo yet.',
          ],
        },
      ],
    },
  },
  {
    id: 'dacha-wifi-password',
    themes: ['no-answer'],
    language: 'en',
    question: 'What is the Wi-Fi password at the dacha?',
    expected: {
      kind: 'not-in-bank',
      note: 'No file mentions a Wi-Fi network or password at the dacha.',
      absentTerms: ['password', 'пароль', 'passphrase'],
    },
  },
  {
    id: 'lisbon-hotel-address',
    themes: ['no-answer'],
    language: 'ru',
    question: 'Какой адрес у отеля в Лиссабоне?',
    expected: {
      kind: 'not-in-bank',
      note: 'The hotel name, dates and booking code are known, but no file gives a street address.',
      absentTerms: ['address', 'адрес', 'Rua ', 'street'],
    },
  },
];
