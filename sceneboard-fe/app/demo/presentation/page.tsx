import { notFound, redirect } from 'next/navigation';

import {
  resolvePresentationDemoLanguage,
  resolvePresentationDemoUrl,
} from '../../../lib/landing/presentation-demo';

interface PresentationDemoPageProps {
  searchParams: Promise<{ locale?: string | string[] }>;
}

export default async function PresentationDemoPage({ searchParams }: PresentationDemoPageProps) {
  const language = resolvePresentationDemoLanguage((await searchParams).locale);
  const rawDestination =
    language === 'ko'
      ? (process.env.SCENEBOARD_PRESENTATION_DEMO_URL_KO ??
        process.env.SCENEBOARD_PRESENTATION_DEMO_URL)
      : process.env.SCENEBOARD_PRESENTATION_DEMO_URL_EN;
  const destination = resolvePresentationDemoUrl(rawDestination);
  if (destination === null) notFound();
  redirect(destination);
}
