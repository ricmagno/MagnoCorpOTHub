# Frontend Design System (MagnoCorpOTHub client)

Canonical UI patterns for `client/src/components/`. When adding a new configuration/settings
panel, form, or admin screen, match these exactly instead of inventing new Tailwind classes —
this file exists because "Branding" and "Identity Provider" configuration panels shipped with
ad-hoc `bg-blue-*` styling and raw `<button>` elements instead of the app's actual `primary`
theme color and shared `Button` component, producing a visibly inconsistent settings UI.

## Color tokens

The app's brand/action color is Tailwind's custom **`primary`** palette (`client/tailwind.config.js`),
**not** the default `blue-*` palette:

| Token | Hex | Use |
|---|---|---|
| `primary-500` | `#0ea5e9` | focus rings |
| `primary-600` | `#0284c7` | default button/accent background |
| `primary-700` | hover shade | button hover |

Never write `bg-blue-600`, `focus:ring-blue-500`, etc. in application UI — use `bg-primary-600`,
`focus:ring-primary-500`. (An *exception*: a page that previews a user-configurable brand color,
like Branding settings, may legitimately override a button's background via an inline `style`
prop bound to that setting — see `BrandingConfiguration.tsx`'s Save button. That's a deliberate
live preview, not a copy-paste of the wrong color token.)

## Buttons

Always use the shared `Button` component (`client/src/components/ui/Button.tsx`), never a raw
`<button>` with hand-rolled classes:

```tsx
import { Button } from '../ui/Button'; // adjust relative path

<Button type="submit" loading={isSaving}>
  <Save className="h-4 w-4 mr-2" />
  {isSaving ? 'Saving…' : 'Save Settings'}
</Button>

<Button type="button" variant="outline" onClick={handleTest} loading={isTesting}>
  <PlugZap className="h-4 w-4 mr-2" />
  Test Connection
</Button>
```

- `variant`: `primary` (default) for the main submit/save action, `outline` for secondary actions
  (Test Connection, Upload, Cancel), `ghost` for the least prominent action, `secondary` for a
  neutral filled action.
- `loading`: pass the in-flight boolean directly — the component renders its own spinner *and*
  disables the button. Don't hand-roll `<Loader2 className="animate-spin" />` conditionals.
- For a destructive action with no dedicated variant (e.g. "Remove Logo"), use
  `variant="outline"` plus a `className` color override — `cn()` uses `tailwind-merge`, so
  `className="border-red-200 text-red-600 hover:bg-red-50"` correctly replaces the outline
  variant's gray border/text instead of conflicting with it.

## Toggle switches ("Enable X")

Pattern used for every enable/disable setting (see `AlertDeliveryConfiguration.tsx`,
`IdentityProviderConfiguration.tsx`). The row gets its own light gray box; the control is a
pill switch, not a checkbox:

```tsx
<div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
  <div>
    <p className="text-sm font-semibold text-gray-900">Enable X</p>
    <p className="text-xs text-gray-500 mt-0.5">One-line description of what this does</p>
  </div>
  <button
    type="button"
    onClick={() => setEnabled(!enabled)}
    className={cn(
      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
      enabled ? 'bg-primary-600' : 'bg-gray-300'
    )}
    aria-label="Toggle X"
  >
    <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white transition-transform', enabled ? 'translate-x-6' : 'translate-x-1')} />
  </button>
</div>
```

Never use a plain `<input type="checkbox">` for a section-level enable/disable toggle.

## Form inputs

```tsx
<input
  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
/>
```

Monospace fields (URLs, DNs, connection strings) additionally get `font-mono`.

## Section cards

A settings section is a white card: `bg-white rounded-lg border border-gray-200 p-6 space-y-4`
(or `space-y-6` for the outer page). A sub-heading inside a card is
`text-sm font-semibold text-gray-900 uppercase tracking-wide`.

## Configuration tabs

The `ConfigurationManagement.tsx` tab strip uses a dedicated CSS class, not Tailwind utilities —
`className={cn("tab-button", configTab === 'my-tab' && "active")}`, styled in
`ConfigurationManagement.css` (`.tab-button.active` already uses `primary-600`). Every new
config tab must reuse this exact class; don't add per-tab custom styling here.
