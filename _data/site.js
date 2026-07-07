// site.js — replaces the _config.yml `site.*` values that templates reference.
// Kept in sync with _config.yml until the Jekyll config is removed at cutover (P10).
export default {
  title: 'General Physics',
  tagline: 'An Open Textbook',
  description:
    'This introductory, algebra-based, college physics book is grounded with ' +
    'real-world examples, illustrations, and explanations to help students ' +
    'grasp key, fundamental physics concepts.',
  author: 'Martin Veillette',
  url: 'https://veillette.github.io',
  // Replaces Jekyll's site.github.repository_url (jekyll-github-metadata).
  repositoryUrl: 'https://github.com/veillette/physics-book2',
};
