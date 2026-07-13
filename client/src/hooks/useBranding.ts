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
  companyName: 'MagnoCorp',
  appName: 'OT Hub',
  siteName: '',
  primaryColor: '#2563EB',
  accentColor: '#7C3AED',
  website: 'https://www.magnocorp.com',
  reportFooter: '',
  emailSenderName: 'MagnoCorpOTHub',
  hasLogo: false
};

// The platform's own base identity. When an admin customizes Company Name
// and/or Platform Name away from these, the UI shows a small
// "Powered by MagnoCorp OT Hub" attribution alongside the custom name.
export const BASE_COMPANY_NAME = 'MagnoCorp';
export const BASE_APP_NAME = 'OT Hub';

export function isCustomBranded(settings: Pick<BrandingSettings, 'companyName' | 'appName'>): boolean {
  return (
    (!!settings.companyName && settings.companyName !== BASE_COMPANY_NAME) ||
    (!!settings.appName && settings.appName !== BASE_APP_NAME)
  );
}

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
