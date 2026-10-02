/**
 * studio/views/NewAutomationView.tsx — the "New automation" route.
 *
 * Renders the builder canvas in new mode: a fully editable local draft
 * (trigger + steps, catalog-driven editor). Saving, dry-run, and deploy
 * call the real automations endpoints and degrade honestly until the
 * backend builder slice lands.
 */
import BuilderView from './BuilderView';

export default function NewAutomationView() {
  return <BuilderView mode="new" />;
}
