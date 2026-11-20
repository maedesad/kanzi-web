import { normalizeQuery, type VocabularyRepository, type Word } from '../domain/vocabulary';
import { apiRequest } from './api/client';
import { fromApiCard, toApiCard } from './api/cardMapper';

// Paths are relative to VITE_API_BASE_URL, which includes /api.
export const endpoints = {
  cards: '/cards',
  card: (word: string) => `/cards/${encodeURIComponent(word)}`,
  generate: (word: string) => `/cards/${encodeURIComponent(word)}/generate`,
  search: (query: string) => `/cards/search?q=${encodeURIComponent(query)}`,
};

export function createHttpRepository(): VocabularyRepository {
  const drafts = new Map<string, Word>();

  async function savedNames(signal?: AbortSignal): Promise<string[]> {
    const names = await apiRequest(endpoints.cards, { signal });
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
      throw new Error('The API returned an invalid word list.');
    }
    return [...new Set(names as string[])];
  }
  async function matchedNames(query: string, signal?: AbortSignal): Promise<string[]> {
    const names = await apiRequest(endpoints.search(query), { signal });
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
      throw new Error('The API returned an invalid word list.');
    }
    return [...new Set(names as string[])];
  }
  async function readCards(names: string[], signal?: AbortSignal): Promise<Word[]> {
    const cards: Word[] = [];
    // The search endpoint returns names only; limit concurrent detail requests.
    for (let index = 0; index < names.length; index += 4) {
      cards.push(...await Promise.all(names.slice(index, index + 4).map(name => readCard(name, signal))));
    }
    return cards;
  }
  async function readCard(id: string, signal?: AbortSignal): Promise<Word> {
    return fromApiCard(await apiRequest(endpoints.card(id), { signal }));
  }
  return {
    capabilities: { deleteWords: false, deleteMeanings: false, translations: false, suggestions: false },
    async listWords(query = '', signal) {
      // Live queries are resolved by the API's fuzzy search; empty query lists the whole library.
      const names = query ? await matchedNames(query, signal) : await savedNames(signal);
      return readCards(names, signal);
    },
    async getWord(id, signal) { return drafts.get(id) ?? readCard(id, signal); },
    async searchWords(query, signal, options) {
      const needle = normalizeQuery(query);
      if (!needle) return { match: [], suggested: [] };
      if (/[\u0600-\u06ff]/.test(query)) {
        throw new Error('Persian search is not available yet. Please search with an English word.');
      }
      if (options?.live) {
        // While typing: saved and draft matches only; generation happens on explicit submit.
        const names = await matchedNames(query, signal);
        const matches = await readCards(names, signal);
        const draftMatches = [...drafts.values()].filter(word => normalizeQuery(word.text).includes(needle));
        return { match: [...matches, ...draftMatches], suggested: [] };
      }
      const existing = (await savedNames(signal)).find(name => normalizeQuery(name) === needle);
      if (existing) return { match: [await readCard(existing, signal)], suggested: [] };
      // Generation is explicitly submitted by the user; never call it while typing.
      const cached = [...drafts.values()].find(word => normalizeQuery(word.text) === needle);
      const word = cached ?? fromApiCard(await apiRequest(endpoints.generate(query.trim()), { method: 'POST', signal }));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      drafts.set(word.id, word);
      return { match: [word], suggested: [] };
    },
    async addWord(id, meaningIds) {
      // POST is insert-only: check for an existing card to avoid restoring excluded meanings.
      const existing = (await savedNames()).find(name => normalizeQuery(name) === normalizeQuery(id));
      if (existing) { drafts.delete(id); return readCard(existing); }
      const source = drafts.get(id);
      if (!source) throw new Error('Search for this word again before adding it.');
      const selected = { ...source, meanings: source.meanings.filter(meaning => meaningIds.includes(meaning.id)) };
      if (!selected.meanings.length) throw new Error('Keep at least one meaning before adding this word.');
      const saved = fromApiCard(await apiRequest(endpoints.cards, { method: 'POST', body: JSON.stringify(toApiCard(selected)) }));
      drafts.delete(id);
      return saved;
    },
    async deleteWord() { throw new Error('Deleting saved words is not supported by the current API.'); },
    async deleteMeaning() { throw new Error('Editing saved meanings is not supported by the current API.'); },
  };
}

export const httpRepository = createHttpRepository();
