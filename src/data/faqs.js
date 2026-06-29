// Single source of truth for the FAQ content.
// Rendered visually by Support.astro and as JSON-LD FAQPage data by index.astro.
// Answers may contain inline HTML (links); the JSON-LD consumer strips tags for plain text.
export const faqs = [
  { q: 'Do I need to create an account?', a: 'Yes. A free Art Whisper account lets us save your discoveries across devices and keeps your personal gallery private to you. Sign in takes a few seconds with Google, Facebook, or email.' },
  { q: 'Does it work without an internet connection?', a: 'Art Whisper needs a connection to identify paintings and pull up their stories. Most museums have decent wifi these days, and 4G usually works fine inside galleries. We\'re working on offline support for saved artworks down the road.' },
  { q: 'What if it can\'t identify the painting I\'m looking at?', a: 'It happens, especially with smaller galleries or lesser-known works. When it does, you can try again from a different angle, or submit the photo for our team to look at. Manual reviews aren\'t real-time, but next time you open the app, the answer might be waiting.' },
  { q: 'Does it only work in museums?', a: 'Not at all. Art Whisper works on any visual art you point your camera at: sculptures, prints in books, postcards, posters in a hotel hallway, murals on the street. If it has a story, we want to tell it.' },
  { q: 'Do I have to be in front of the artwork to use it?', a: 'No. You can point your camera at a painting in the moment, or upload a photo you\'ve already taken. Both work the same way. Useful when you remember a painting from last year\'s trip but never caught its name.' },
  { q: 'What about my privacy? Where do my photos go?', a: 'The photo you scan goes to our servers to identify the artwork, then is deleted once it\'s processed. If we can\'t recognize it, we may keep the photo for up to thirty days to improve our accuracy, then delete it permanently. Location is optional. If you grant it, we use it to show you what\'s nearby. We don\'t sell your data to anyone, ever. Full details in our <a href="https://api.artwhisper.app/privacy" target="_blank" rel="noopener">Privacy Policy</a>.' },
  { q: 'When will it be on iPhone?', a: 'We\'re working on it. Android is live now; iOS is in development and we\'re aiming for later this year.' },
  { q: 'What languages does it work in?', a: 'English at launch, with more languages on the way as our community grows.' },
  { q: 'I run a museum or gallery. Can we work together?', a: 'Yes. We\'d love to talk. Drop a note to <a href="mailto:partnerships@artwhisper.app?subject=Partnership%20inquiry">partnerships@artwhisper.app</a> and we\'ll be in touch.' },
  { q: 'How is the audio narration made?', a: 'Each story is written and produced specifically for the app. Not lifted from a textbook, not recycled from somewhere else. The goal is what you\'d hear from a friend who happens to be a curator: warm, accurate, never dry.' },
];

// Strip inline HTML for plain-text contexts (e.g. JSON-LD structured data).
export const stripHtml = (html) => html.replace(/<[^>]+>/g, '');
