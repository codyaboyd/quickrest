import { env } from '../config/env.js';

const demoServices = new Map([
  ['weather', {
    slug: 'weather',
    name: 'Weather API',
    upstreamUrl: 'https://api.open-meteo.com/v1/forecast',
    creditCost: env.DEFAULT_CREDIT_COST
  }],
  ['httpbin', {
    slug: 'httpbin',
    name: 'HTTPBin Echo',
    upstreamUrl: 'https://httpbin.org/anything',
    creditCost: env.DEFAULT_CREDIT_COST
  }]
]);

export function listDemoServices() {
  return [...demoServices.values()];
}

export async function proxyRequest(serviceSlug, request) {
  const service = demoServices.get(serviceSlug);
  if (!service) {
    return { status: 404, body: { error: 'Unknown API service' } };
  }

  const sourceUrl = new URL(request.url);
  const upstreamUrl = new URL(service.upstreamUrl);
  sourceUrl.searchParams.forEach((value, key) => upstreamUrl.searchParams.set(key, value));

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      accept: request.headers.get('accept') || 'application/json',
      'user-agent': 'QuickRest/0.1'
    }
  });

  const contentType = upstreamResponse.headers.get('content-type') || 'application/json';
  const body = contentType.includes('application/json')
    ? await upstreamResponse.json()
    : await upstreamResponse.text();

  return {
    status: upstreamResponse.status,
    body: {
      service: service.slug,
      creditsCharged: service.creditCost,
      upstreamStatus: upstreamResponse.status,
      data: body
    }
  };
}
