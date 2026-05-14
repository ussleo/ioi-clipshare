# ioiClipShare by Claude

WiFi clipboard sharing entre dispositivos en la misma red. Diseño **ioiBURN lineage**.

---

## Stack

- **Backend:** Node.js + Express + WebSockets + Multer
- **DB:** SQLite via `better-sqlite3` (WAL mode, sesiones persistentes)
- **Frontend:** Vanilla JS + CSS (JetBrains Mono, gradiente naranja→púrpura)

---

## Arranque

```bash
# Instalar dependencias
npm install

# Iniciar (con ventana)
npm start

# Iniciar en background (sin ventana CMD — Windows)
start.vbs

# Detener
stop.bat
```

Acceder en `http://localhost:9977`  
PIN por defecto: `1stbrain` (cambiar en `server.js` o via `CLIPSHARE_PIN` env var)

---

## Features v2

- Historial de hasta 200 clips (texto, URLs, imágenes, video, archivos, bundles)
- **Edición por item** — texto, label, adjuntos editables inline
- **Preview inline** de archivos `.txt` y `.md`
- **Calendario lateral** — dots naranjas en días con items, click filtra el feed
- **Panel de títulos** por fecha — acceso rápido a cualquier anotación
- **Wipe protegido** con modal de confirmación
- Selección de texto estable (smart DOM updates, sin re-renders globales)
- Paste de screenshots con `Alt+PrtSc` → `Ctrl+V`
- Reconexión automática con backoff + polling offline
- Launcher sin ventana CMD (`start.vbs`) + `stop.bat` por puerto

---

## Configuración

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `9977` | Puerto del servidor |
| `CLIPSHARE_PIN` | `1stbrain` | PIN de acceso |

---

## 🌱 Visión futura — ClipShare como microservicio de anotaciones

> *Semilla plantada el 14/05/2026*

La idea: **ClipShare como plugin embebible** dentro de cualquier aplicación ioi.

### El caso de uso

Un usuario trabaja con **gluqo2** (IA médica). En el metro se le ocurre una pregunta sobre su condición. La guarda en ClipShare desde el móvil. Más tarde, en casa, abre gluqo2 — la IA recoge sus anotaciones pendientes del ClipShare personal del usuario y las responde en contexto.

Lo mismo aplica para **GlukoGemini**, **ioiLab**, o cualquier app futura: cada usuario tiene su propio espacio de anotaciones que la IA puede leer cuando el momento sea el correcto.

### Lo que ya existe

ClipShare ya expone todo lo necesario via API REST:

```
POST /api/login          → token de sesión
GET  /api/clipboard      → lista de anotaciones del usuario
POST /api/composite      → crear anotación (texto + archivos)
PUT  /api/clipboard/:id  → editar anotación existente
DELETE /api/clipboard/:id → eliminar
```

### Lo que faltaría construir

- **Multiusuario** — PIN o token de API por usuario, espacios aislados
- **SDK cliente** — un módulo npm pequeño (`ioi-clipshare-client`) que cualquier app importe para leer/escribir anotaciones sin reinventar la rueda
- **Webhook / push** — notificar a la app cuando hay anotaciones nuevas sin pendientes
- **Tags y contexto** — etiquetar anotaciones por app de origen (`#gluqo2`, `#ioilab`) para que la IA filtre por relevancia
- **Deploy cloud opcional** — para acceso desde cualquier red, no solo WiFi local

### El patrón

```
[Usuario en la calle]
        ↓  guarda anotación
   ClipShare (personal, cloud)
        ↓  API GET /api/clipboard
   [IA de gluqo2 / GlukoGemini]
        ↓  responde en contexto
   [Usuario en casa]
```

Un lugar donde guardar el hilo de cualquier idea, para poder regresar y seguir.
