import { useEffect, useState } from 'react';
import { HARNESS_ENABLED_SETTING_KEY } from '../../types/agent';
import { db } from '../../services/db';

export function useHarnessEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void db.settings.get(HARNESS_ENABLED_SETTING_KEY)
      .then((row) => {
        if (cancelled) return;
        setEnabled(row?.value === true || row?.value === 'true');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
