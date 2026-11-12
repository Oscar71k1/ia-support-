# Decisión de proveedor generativo

## Restricción de partida

Al momento de decidir: **no hay `ollama` instalado** y **no hay API keys** en el entorno. Así que
la decisión se tomó por coste de arranque, fiabilidad del JSON y facilidad de demo, no por gusto.

## Opciones evaluadas

| Opción | Arranque | JSON fiable | Coste | Riesgo |
|---|---|---|---|---|
| **Groq** (compatible OpenAI) | API key gratuita, sin tarjeta, ~2 min | Alto con `response_format: json_object` | Gratis con límites | Límite de peticiones; requiere internet |
| **Google Gemini** | API key gratuita (AI Studio) | Alto con `responseMimeType` | Gratis con límites | Requiere internet |
| **OpenAI** | Requiere facturación | Muy alto | De pago | No aporta nada frente a los anteriores para este reto |
| **Ollama local** | Descarga del runtime + modelo (~1–2 GB) | Medio en modelos de 3B; alto en 7B+ | Gratis | Descarga larga; JSON menos consistente en modelos pequeños |

## Recomendación

**Primario: Groq.** Es la vía más rápida a una integración *real* de IA con salida JSON
estructurada, sin tarjeta y sin instalar nada, que es exactamente lo que evalúa el 30% del reto.

**Respaldo: Ollama** (`llama3.2:3b` o similar) para tener una demo offline y un argumento fuerte
en la defensa: "el proveedor es sustituible, el prompt y el contrato no".

**Clave de la decisión:** implementar el cliente contra la interfaz **OpenAI-compatible**
(`POST {base_url}/chat/completions`). Así Groq, Together, vLLM y Ollama hablan el mismo protocolo y
cambiar de proveedor es cambiar tres variables de entorno, no reescribir el motor.

> Verifica el identificador exacto del modelo en la consola del proveedor antes de la demo: los
> modelos se renombran y retiran con frecuencia. No lo dejes escrito a mano en el código.

## Contrato de configuración (acordar con quien haga la API)

```env
LLM_PROVIDER=groq            # groq | ollama | openai
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=<modelo vigente>
LLM_API_KEY=<tu key>
LLM_TIMEOUT_MS=20000
LLM_TEMPERATURE=0
```

- `.env` **nunca** se versiona; `.gitignore` debe incluirlo desde el primer commit.
- `.env.example` se versiona con los mismos nombres y valores vacíos o de ejemplo.
- La key no aparece en logs, mensajes de error, ni en la respuesta HTTP. Si el proveedor devuelve
  un error que contiene la key, se sanea antes de registrar.
- Sin `LLM_API_KEY` (o sin Ollama levantado), `POST /api/analyze` con `mode=generative` debe
  devolver **502/503 con un error genérico**. Eso es la prueba de que la integración es real: si
  responde igual sin proveedor, hay respuestas simuladas y el requisito no se cumple.

## Parámetros de la llamada

| Parámetro | Valor | Motivo |
|---|---|---|
| `temperature` | `0` | Comparación reproducible |
| `max_tokens` | `400` | 2–4 frases de respuesta |
| `timeout` | `20 s` | El endpoint no debe colgarse |
| reintentos | `1`, solo por JSON inválido | No reintentar fallos de red en bucle |
| modo JSON | según proveedor | Ver `prompt/system-prompt.md` |

## Límites reales medidos (plan gratuito)

Medido el 2026-11-12 con la key del equipo: **8 000 tokens por minuto** en los modelos de chat
probados (`gpt-oss-120b`, `gpt-oss-20b`, `qwen3.8-27b`; `allam-2-7b` tiene 6 000) y 1 000
peticiones por minuto. El prompt del sistema consume ~2 000 tokens por petición, así que el techo
real es de **3 a 4 peticiones por minuto**, no 24 seguidas.

Consecuencias para el equipo:

- Las pruebas deben espaciarse (~20 s por caso) o el cliente debe reintentar ante `429`.
- La API debe tratar el `429` como error recuperable: backoff y, si se agota, `503`. Nunca
  devolver una clasificación inventada.
- Una corrida completa de 12 casos tarda 4–5 minutos: planificar la demo con ese tiempo.
- `max_tokens=400` provoca `400 json_validate_failed` con `gpt-oss`, porque el razonamiento
  consume el presupuesto antes de cerrar el JSON. Usar 900.

## Coste esperado de las pruebas

12 peticiones al proveedor, ~2 000 tokens cada una: unos **24 000 tokens por corrida completa**.
Sigue siendo irrelevante en coste, pero no en tiempo por el límite anterior.
