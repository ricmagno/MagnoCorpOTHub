import { useState, useEffect, useCallback, createContext, useContext } from 'react';

export interface BrandingSettings {
  companyName: string;
  appName: string;
  siteName: string;
  primaryColor: string;
  accentColor: string;
  website: string;
  reportFooter: string;
  emailSenderName: string;
  hasLogo: boolean;
}

export const BRANDING_DEFAULTS: BrandingSettings = {
  companyName: '',
  appName: 'MagnoCorpOTHub',
  siteName: '',
  primaryColor: '#2563EB',
  accentColor: '#7C3AED',
  website: '',
  reportFooter: '',
  emailSenderName: 'MagnoCorpOTHub',
  hasLogo: false
};

export interface BrandingContextValue {
  branding: BrandingSettings;
  logoVersion: number;
  refresh: () => Promise<void>;
}

export const BrandingContext = createContext<BrandingContextValue>({
  branding: BRANDING_DEFAULTS,
  logoVersion: 0,
  refresh: async () => {}
});

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}

export function useBrandingProvider(): BrandingContextValue {
  const [branding, setBranding] = useState<BrandingSettings>(BRANDING_DEFAULTS);
  const [logoVersion, setLogoVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/branding');
      if (!res.ok) return;
      const data = await res.json();
      setBranding({ ...BRANDING_DEFAULTS, ...data });
      setLogoVersion(v => v + 1);
    } catch {
      // keep defaults on network failure
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Inject CSS variables and update page title
  useEffect(() => {
    let styleEl = document.getElementById('branding-vars') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'branding-vars';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      :root {
        --brand-primary: ${branding.primaryColor};
        --brand-accent: ${branding.accentColor};
      }
    `;
    const displayName = [branding.companyName, branding.appName].filter(Boolean).join(' ') || 'MagnoCorpOTHub';
    document.title = displayName;
  }, [branding.primaryColor, branding.accentColor, branding.companyName, branding.appName]);

  return { branding, logoVersion, refresh };
}
