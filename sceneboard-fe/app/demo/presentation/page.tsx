import { notFound, redirect } from 'next/navigation';

import { resolvePresentationDemoUrl } from '../../../lib/landing/presentation-demo';

export default function PresentationDemoPage() {
  const destination = resolvePresentationDemoUrl(process.env.SCENEBOARD_PRESENTATION_DEMO_URL);
  if (destination === null) notFound();
  redirect(destination);
}
