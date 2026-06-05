# CLAUDE.md — OMTI2026/API (ELROI CargoDesk · backend Fastify)

Guía para Claude al trabajar en este repo. El runbook de operación está en `OPERACIONES.md`.

## Modelo de ramas (LÉELO ANTES DE TOCAR GIT)

- `develop` = rama de integración/desarrollo. **Todo el trabajo nuevo entra aquí primero.**
- `main` = **producción**. Solo recibe código vía merge/PR **desde `develop`**.

### Reglas duras

1. **NUNCA commitees ni mergees directo a `main`.** Ni features, ni fixes, ni "un cambio chiquito". Todo cambio: rama de trabajo → `develop` → PR a `main`.
2. **Si por una urgencia real algo entró a `main`** (hotfix), haz el **back-merge `main → develop` en el MISMO flujo**, antes de cerrar la tarea. `develop` nunca debe quedarse atrás de `main`.
3. **Los PRs automáticos (claude-code-action / Sentry auto-fix) apuntan a `develop`, jamás a `main`.**

### Chequeo obligatorio antes de terminar cualquier tarea que toque git

```bash
git fetch origin --prune
git rev-list --left-right --count origin/develop...origin/main
#                                  ^develop_only      ^main_only
```

- Si **`main_only` > 0** (main tiene commits que develop no tiene), **es la mala práctica que estamos evitando**:
  1. **Avisa a Omar** (`omar.torres@t-elroi.com`) — di exactamente qué commits están solo en `main` y desde cuándo.
  2. Propón el back-merge `main → develop` y, con su OK, déjalo sincronizado.
  3. No cierres la tarea dejando `develop` atrás de `main` en silencio.

> Contexto: el 2026-06-04 `develop` quedó atrás de `main` en ambos repos (API y TMS) por commitear/mergear directo a `main` sin regresar a `develop`. En API se subieron features/fixes reales directo a prod, saltándose `develop`. Esta política existe para que no se repita.

## Convenciones

- Sigue el estilo y estructura de los archivos hermanos antes de crear algo nuevo.
- No subas secretos: JWT, R2/S3 y DB viven en variables de Railway por entorno, nunca en el repo.
- Verifica con `npm run smoke` cuando aplique antes de dar por buena una entrega.
