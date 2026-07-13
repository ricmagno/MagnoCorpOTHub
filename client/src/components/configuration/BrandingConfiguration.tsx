import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Save, Upload, X } from 'lucide-react';
import { useBranding, BrandingSettings, BRANDING_DEFAULTS, isCustomBranded } from '../../hooks/useBranding';
import { useToast } from '../../hooks/useToast';
import { Button } from '../ui/Button';

const authHeaders = () => ({
  Authorization: `Bearer ${localStorage.getItem('authToken') || ''}`
});

// ── Preview ───────────────────────────────────────────────────────────────────

const NavbarPreview: React.FC<{ settings: BrandingSettings; logoVersion: number }> = ({ settings, logoVersion }) => {
  const displayName = [settings.companyName, settings.appName].filter(Boolean).join(' ') || 'OT Hub';
  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden">
      <p className="text-xs font-medium text-gray-500 px-3 pt-2 pb-1 bg-gray-50 border-b border-gray-200">
        Navbar preview
      </p>
      <nav
        className="bg-white px-4 h-14 flex items-center space-x-3"
        style={{ borderBottom: `2px solid ${settings.primaryColor}20` }}
      >
        <div className="flex items-center space-x-2">
          {settings.hasLogo ? (
            <img
              src={`/api/branding/logo?v=${logoVersion}`}
              alt="logo"
              className="h-7 w-auto object-contain"
            />
          ) : (
            <img src="/logo192.png" alt="" className="h-7 w-auto object-contain" />
          )}
          <div className="flex flex-col leading-tight">
            <span className="text-lg font-bold text-gray-900">{displayName}</span>
            {isCustomBranded(settings) && (
              <span className="text-[10px] text-gray-400">Powered by MagnoCorp OT Hub</span>
            )}
          </div>
        </div>
        {settings.siteName && (
          <span className="text-xs text-gray-500 border-l border-gray-200 pl-3">{settings.siteName}</span>
        )}
      </nav>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

export const BrandingConfiguration: React.FC = () => {
  const { branding, logoVersion, refresh } = useBranding();
  const { success, error: toastError } = useToast();

  const [form, setForm] = useState<BrandingSettings>(BRANDING_DEFAULTS);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [isRemovingLogo, setIsRemovingLogo] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setForm(branding); }, [branding]);

  const set = (key: keyof BrandingSettings, value: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: value }));

  const handleSave = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const res = await fetch('/api/branding', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      success('Branding saved', 'Your changes are now live.');
    } catch {
      toastError('Save failed', 'Could not update branding settings.');
    } finally {
      setIsSaving(false);
    }
  }, [form, refresh, success, toastError]);

  const handleLogoUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      const res = await fetch('/api/branding/logo', {
        method: 'POST',
        headers: authHeaders(),
        body: fd
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setForm(prev => ({ ...prev, hasLogo: true }));
      success('Logo uploaded');
    } catch {
      toastError('Upload failed', 'Max size is 2 MB. Use PNG, JPG, or SVG.');
    } finally {
      setIsUploadingLogo(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [refresh, success, toastError]);

  const handleRemoveLogo = useCallback(async () => {
    setIsRemovingLogo(true);
    try {
      const res = await fetch('/api/branding/logo', {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (!res.ok) throw new Error();
      await refresh();
      setForm(prev => ({ ...prev, hasLogo: false }));
      success('Logo removed');
    } catch {
      toastError('Failed to remove logo');
    } finally {
      setIsRemovingLogo(false);
    }
  }, [refresh, success, toastError]);

  return (
    <form onSubmit={handleSave} className="space-y-6 mt-6">

      {/* Company Identity */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Company Identity</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
            <input
              type="text"
              value={form.companyName}
              onChange={e => set('companyName', e.target.value)}
              placeholder="e.g. MagnoCorp"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Platform Name</label>
            <input
              type="text"
              value={form.appName}
              onChange={e => set('appName', e.target.value)}
              placeholder="e.g. OT Hub"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Site / Facility Name</label>
            <input
              type="text"
              value={form.siteName}
              onChange={e => set('siteName', e.target.value)}
              placeholder="e.g. Plant 1 – Melbourne"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company Website</label>
            <input
              type="url"
              value={form.website}
              onChange={e => set('website', e.target.value)}
              placeholder="https://example.com.au"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>
      </section>

      {/* Visual Identity */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Visual Identity</h3>

        {/* Logo */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Logo</label>
          <div className="flex items-center gap-3">
            {form.hasLogo && (
              <img
                src={`/api/branding/logo?v=${logoVersion}`}
                alt="Current logo"
                className="h-10 w-auto object-contain rounded border border-gray-200 p-1 bg-gray-50"
              />
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLogoUpload}
            />
            <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} loading={isUploadingLogo}>
              <Upload className="h-4 w-4 mr-2" />
              {form.hasLogo ? 'Replace Logo' : 'Upload Logo'}
            </Button>
            {form.hasLogo && (
              <Button
                type="button"
                variant="outline"
                onClick={handleRemoveLogo}
                loading={isRemovingLogo}
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-600"
              >
                <X className="h-4 w-4 mr-2" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">PNG, JPG, or SVG · max 2 MB · recommended height 40–60 px</p>
        </div>

        {/* Colours */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Primary Colour</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.primaryColor}
                onChange={e => set('primaryColor', e.target.value)}
                className="h-9 w-14 rounded border border-gray-300 cursor-pointer p-0.5"
              />
              <input
                type="text"
                value={form.primaryColor}
                onChange={e => set('primaryColor', e.target.value)}
                className="w-28 px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Accent Colour</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={form.accentColor}
                onChange={e => set('accentColor', e.target.value)}
                className="h-9 w-14 rounded border border-gray-300 cursor-pointer p-0.5"
              />
              <input
                type="text"
                value={form.accentColor}
                onChange={e => set('accentColor', e.target.value)}
                className="w-28 px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Communications */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Communications</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Email Sender Name</label>
          <input
            type="text"
            value={form.emailSenderName}
            onChange={e => set('emailSenderName', e.target.value)}
            placeholder="e.g. MagnoCorp OT Hub"
            className="w-full max-w-sm px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <p className="text-xs text-gray-500 mt-1">Appears in the "From" field of automated report emails.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Report Footer Text</label>
          <textarea
            value={form.reportFooter}
            onChange={e => set('reportFooter', e.target.value)}
            rows={2}
            placeholder="e.g. Confidential – MagnoCorp Pty Ltd · plant@magnomcorp.com.au"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
          />
          <p className="text-xs text-gray-500 mt-1">Printed at the bottom of every PDF report.</p>
        </div>
      </section>

      {/* Preview */}
      <section className="bg-white rounded-lg border border-gray-200 p-6 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Preview</h3>
        <NavbarPreview settings={form} logoVersion={logoVersion} />
      </section>

      {/* Save */}
      <div className="flex justify-end">
        <Button type="submit" loading={isSaving} style={{ backgroundColor: form.primaryColor }}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>

    </form>
  );
};
