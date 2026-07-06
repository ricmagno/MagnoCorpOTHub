import React, { useState, useEffect, useCallback } from 'react';
import { Save, CheckCircle2, XCircle, PlugZap } from 'lucide-react';
import { useToast } from '../../hooks/useToast';
import { cn } from '../../utils/cn';
import { Button } from '../ui/Button';

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem('authToken') || ''}`
});

const MASK = '••••••••';

interface LdapForm {
  enabled: boolean;
  defaultRole: 'user' | 'view-only';
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userFilter: string;
  tlsRejectUnauthorized: boolean;
  caCert: string;
}

interface OidcForm {
  enabled: boolean;
  defaultRole: 'user' | 'view-only';
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

const LDAP_DEFAULTS: LdapForm = {
  enabled: false,
  defaultRole: 'view-only',
  url: '',
  bindDn: '',
  bindPassword: '',
  baseDn: '',
  userFilter: '(sAMAccountName={{username}})',
  tlsRejectUnauthorized: true,
  caCert: ''
};

const OIDC_DEFAULTS: OidcForm = {
  enabled: false,
  defaultRole: 'view-only',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email'
};

interface ProviderRecord {
  id: 'ldap' | 'oidc';
  enabled: boolean;
  defaultRole: 'user' | 'view-only';
  config: Record<string, string | boolean>;
}

// ── LDAP section ──────────────────────────────────────────────────────────────

const LdapSection: React.FC<{ initial: LdapForm; onSaved: (record: ProviderRecord) => void }> = ({ initial, onSaved }) => {
  const { success, error: toastError } = useToast();
  const [form, setForm] = useState<LdapForm>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);

  useEffect(() => { setForm(initial); }, [initial]);

  const set = <K extends keyof LdapForm>(key: K, value: LdapForm[K]) => {
    setTestResult(null);
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const { enabled, defaultRole, ...config } = form;
      const res = await fetch('/api/identity-providers/ldap', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, defaultRole, config })
      });
      if (!res.ok) throw new Error(await res.text());
      const { provider } = await res.json();
      onSaved(provider);
      success('LDAP settings saved', 'Your changes are now live.');
    } catch {
      toastError('Save failed', 'Could not update LDAP settings.');
    } finally {
      setIsSaving(false);
    }
  }, [form, onSaved, success, toastError]);

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/identity-providers/ldap/test', { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      setTestResult({ success: !!data.success, error: data.error });
    } catch {
      setTestResult({ success: false, error: 'Request failed' });
    } finally {
      setIsTesting(false);
    }
  }, []);

  return (
    <form onSubmit={handleSave} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">LDAP / Active Directory</h3>
          <p className="text-xs text-gray-500 mt-1">Direct bind against a Domain Controller — works on isolated plant networks with no internet dependency.</p>
        </div>
        <button
          type="button"
          onClick={() => set('enabled', !form.enabled)}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
            form.enabled ? 'bg-primary-600' : 'bg-gray-300'
          )}
          aria-label="Toggle LDAP / Active Directory"
        >
          <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', form.enabled ? 'translate-x-6' : 'translate-x-1')} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Server URL</label>
          <input
            type="text" value={form.url} onChange={e => set('url', e.target.value)}
            placeholder="ldaps://dc01.corp.example.com:636"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Bind DN</label>
          <input
            type="text" value={form.bindDn} onChange={e => set('bindDn', e.target.value)}
            placeholder="CN=svc-othub,OU=Service Accounts,DC=corp,DC=example,DC=com"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Bind Password</label>
          <input
            type="password" value={form.bindPassword} onChange={e => set('bindPassword', e.target.value)}
            placeholder={MASK}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Base DN</label>
          <input
            type="text" value={form.baseDn} onChange={e => set('baseDn', e.target.value)}
            placeholder="DC=corp,DC=example,DC=com"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">User Filter</label>
          <input
            type="text" value={form.userFilter} onChange={e => set('userFilter', e.target.value)}
            placeholder="(sAMAccountName={{username}})"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <p className="text-xs text-gray-500 mt-1"><code>{'{{username}}'}</code> is replaced with the submitted login name.</p>
        </div>
        <div className="md:col-span-2">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <input type="checkbox" checked={form.tlsRejectUnauthorized} onChange={e => set('tlsRejectUnauthorized', e.target.checked)} className="h-4 w-4" />
            Verify server TLS certificate
          </label>
        </div>
        {!form.tlsRejectUnauthorized && (
          <div className="md:col-span-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            Certificate verification is off — only use this for testing against a self-signed test server, never in production.
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">JIT Default Role</label>
          <select
            value={form.defaultRole} onChange={e => set('defaultRole', e.target.value as LdapForm['defaultRole'])}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="view-only">View-Only</option>
            <option value="user">User</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">Role assigned to a directory account the first time it logs in.</p>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
        <Button type="button" variant="outline" onClick={handleTest} loading={isTesting}>
          <PlugZap className="h-4 w-4 mr-2" />
          Test Connection
        </Button>
        {testResult && (
          testResult.success ? (
            <span className="flex items-center gap-1 text-sm text-green-700"><CheckCircle2 className="h-4 w-4" /> Connected successfully</span>
          ) : (
            <span className="flex items-center gap-1 text-sm text-red-700"><XCircle className="h-4 w-4" /> {testResult.error || 'Connection failed'}</span>
          )
        )}
        <div className="flex-1" />
        <Button type="submit" loading={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Saving…' : 'Save LDAP Settings'}
        </Button>
      </div>
    </form>
  );
};

// ── OIDC section ──────────────────────────────────────────────────────────────

const OidcSection: React.FC<{ initial: OidcForm; onSaved: (record: ProviderRecord) => void }> = ({ initial, onSaved }) => {
  const { success, error: toastError } = useToast();
  const [form, setForm] = useState<OidcForm>(initial);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => { setForm(initial); }, [initial]);

  const set = <K extends keyof OidcForm>(key: K, value: OidcForm[K]) => setForm(prev => ({ ...prev, [key]: value }));

  const handleSave = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const { enabled, defaultRole, ...config } = form;
      const res = await fetch('/api/identity-providers/oidc', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, defaultRole, config })
      });
      if (!res.ok) throw new Error(await res.text());
      const { provider } = await res.json();
      onSaved(provider);
      success('OIDC settings saved', 'Your changes are now live.');
    } catch {
      toastError('Save failed', 'Could not update OIDC settings.');
    } finally {
      setIsSaving(false);
    }
  }, [form, onSaved, success, toastError]);

  return (
    <form onSubmit={handleSave} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">OpenID Connect</h3>
          <p className="text-xs text-gray-500 mt-1">Browser-redirect SSO for Entra ID, Okta, Auth0, Keycloak, and other OIDC-compatible providers.</p>
        </div>
        <button
          type="button"
          onClick={() => set('enabled', !form.enabled)}
          className={cn(
            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
            form.enabled ? 'bg-primary-600' : 'bg-gray-300'
          )}
          aria-label="Toggle OpenID Connect"
        >
          <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', form.enabled ? 'translate-x-6' : 'translate-x-1')} />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">Issuer URL</label>
          <input
            type="text" value={form.issuer} onChange={e => set('issuer', e.target.value)}
            placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Client ID</label>
          <input
            type="text" value={form.clientId} onChange={e => set('clientId', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Client Secret</label>
          <input
            type="password" value={form.clientSecret} onChange={e => set('clientSecret', e.target.value)}
            placeholder={MASK}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Scopes</label>
          <input
            type="text" value={form.scopes} onChange={e => set('scopes', e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">JIT Default Role</label>
          <select
            value={form.defaultRole} onChange={e => set('defaultRole', e.target.value as OidcForm['defaultRole'])}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="view-only">View-Only</option>
            <option value="user">User</option>
          </select>
        </div>
      </div>

      <div className="flex items-center pt-2 border-t border-gray-100">
        <div className="flex-1" />
        <Button type="submit" loading={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Saving…' : 'Save OIDC Settings'}
        </Button>
      </div>
    </form>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const IdentityProviderConfiguration: React.FC = () => {
  const [ldapForm, setLdapForm] = useState<LdapForm>(LDAP_DEFAULTS);
  const [oidcForm, setOidcForm] = useState<OidcForm>(OIDC_DEFAULTS);
  const [loading, setLoading] = useState(true);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/identity-providers', { headers: authHeaders() });
      if (!res.ok) return;
      const { providers } = await res.json() as { providers: ProviderRecord[] };

      const ldap = providers.find(p => p.id === 'ldap');
      if (ldap) {
        setLdapForm(prev => ({ ...prev, ...(ldap.config as Partial<LdapForm>), enabled: ldap.enabled, defaultRole: ldap.defaultRole }));
      }
      const oidc = providers.find(p => p.id === 'oidc');
      if (oidc) {
        setOidcForm(prev => ({ ...prev, ...(oidc.config as Partial<OidcForm>), enabled: oidc.enabled, defaultRole: oidc.defaultRole }));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProviders(); }, [fetchProviders]);

  const handleLdapSaved = (record: ProviderRecord) => {
    setLdapForm(prev => ({ ...prev, ...(record.config as Partial<LdapForm>), enabled: record.enabled, defaultRole: record.defaultRole }));
  };
  const handleOidcSaved = (record: ProviderRecord) => {
    setOidcForm(prev => ({ ...prev, ...(record.config as Partial<OidcForm>), enabled: record.enabled, defaultRole: record.defaultRole }));
  };

  if (loading) {
    return <div className="mt-6 text-sm text-gray-500">Loading identity provider settings…</div>;
  }

  return (
    <div className="space-y-6 mt-6">
      <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3">
        Local username/password accounts always remain available alongside any provider
        enabled below — useful for break-glass admin access and plant networks that can't
        reach a directory server. A user only tries these providers if no local account
        matches the submitted username.
      </div>
      <LdapSection initial={ldapForm} onSaved={handleLdapSaved} />
      <OidcSection initial={oidcForm} onSaved={handleOidcSaved} />
    </div>
  );
};

export default IdentityProviderConfiguration;
