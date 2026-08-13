import { type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'

/** Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. */
export function startTelemetry(): () => Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return async () => {}
  const provider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  })
  provider.register()
  return () => provider.shutdown()
}

export function traced<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: (s: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer('fixlane').startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span)
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message })
      throw e
    } finally {
      span.end()
    }
  })
}
