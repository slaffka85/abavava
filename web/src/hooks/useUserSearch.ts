import { useEffect, useState } from 'react';
import { api, humanizeApiError } from '../lib/api';
import type { User } from '../lib/types';

const DEBOUNCE_MS = 300;

interface UseUserSearchResult {
  results: User[];
  loading: boolean;
  error: string | null;
}

/** Поиск пользователей с дебаунсом и отменой устаревших запросов. */
export function useUserSearch(query: string, limit = 20): UseUserSearchResult {
  const [results, setResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const timer = window.setTimeout(() => {
      void api.users
        .search(trimmed, limit, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setResults(response.items);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(humanizeApiError(cause));
          setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, limit]);

  return { results, loading, error };
}
