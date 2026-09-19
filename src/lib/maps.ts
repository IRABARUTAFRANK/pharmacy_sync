import L from "leaflet"
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png"
import markerIcon from "leaflet/dist/images/marker-icon.png"
import markerShadow from "leaflet/dist/images/marker-shadow.png"

// Leaflet's default marker icon is normally resolved via relative URLs
// baked into its own CSS, which breaks once bundled by Vite -- the standard
// fix is pointing it at the bundler-resolved asset URLs instead, once,
// before any L.marker() is ever created. Runs as a module-level side
// effect since every map on this page already imports this file for
// haversineKm()/getCurrentDeviceLocation(), so there's no separate setup
// call either map component needs to remember to make.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// Device geolocation + distance math shared by the branch location picker
// (BranchSettingsPage) and the branches overview map (OrganizationPage).
// The actual map rendering uses Leaflet (npm package, MIT-licensed) with
// OpenStreetMap tiles directly in each page -- both are completely free,
// need no API key, no Google Cloud project, and no billing account ever.
// This file used to load the Google Maps JavaScript API instead (a real
// script + API key), swapped out because the user asked for a genuinely
// free option -- see this session's own explanation of the tradeoff:
// OpenStreetMap tiles are free for reasonable, moderate traffic (this
// app's usage -- a handful of branches, occasional views -- is well within
// that), whereas Google's Maps JavaScript API requires a billing-enabled
// account even though light usage stays under its free monthly credit.

export interface DeviceLocation {
  lat: number
  lng: number
  // Radius in meters the browser itself reports for how trustworthy this
  // reading is (GeolocationCoordinates.accuracy) -- a phone with a clear
  // sky view might report ~10m, a laptop on wifi indoors might report
  // 500m+. Surfaced so the UI can warn rather than silently trust a bad
  // reading -- the real fix for "the device may be displaced" is the
  // address search below, not blind faith in GPS.
  accuracyMeters: number | null
}

// Promisified navigator.geolocation.getCurrentPosition with messages a user
// can actually act on instead of a raw GeolocationPositionError code.
export function getCurrentDeviceLocation(): Promise<DeviceLocation> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This device or browser does not support location detection"))
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy ?? null }),
      err => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(new Error("Location access was denied -- allow it in your browser settings, or search your address instead"))
        } else if (err.code === err.TIMEOUT) {
          reject(new Error("Location request timed out -- try again, or search your address instead"))
        } else {
          reject(new Error("Could not determine your location -- search your address instead"))
        }
      },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })
}

export interface GeocodeResult {
  lat: number
  lng: number
  displayName: string
}

// Free address search via OpenStreetMap's Nominatim, the accurate,
// professional alternative to trusting a device's GPS: typing the
// pharmacy's real registered address and picking the matching result
// pins the exact spot regardless of where the person setting it up
// happens to physically be standing (a laptop at home, a phone with a
// drifting signal, etc. -- exactly the "the device may be the one that
// moved" problem). Nominatim's usage policy
// (https://operations.osmfoundation.org/policies/nominatim/) asks for at
// most one request per explicit user action (never per keystroke) and no
// bulk/automated use -- this is only ever called from a deliberate
// "Search" click or Enter press, never live-as-you-type, so it stays
// comfortably within that.
//
// countrycodes=rw biases/filters results to Rwanda, matching every other
// Rwanda-specific assumption already baked into this app (RRA/TIN
// compliance, EBM device serial, RWF currency, the rw locale) -- without
// it, a short or common place name can match somewhere else in the world
// first. This does NOT manufacture street-level detail that doesn't exist
// in OpenStreetMap yet -- OSM's address coverage genuinely varies by
// area, and in places where a specific street isn't mapped in detail,
// only a city/neighbourhood/known-landmark match will come back. That's
// expected, not a bug: search gets you close, then dragging the pin (see
// BranchLocationMap) places it exactly, and the final saved coordinates
// are precise either way since dragging sets them directly.
export async function geocodeAddress(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=8&countrycodes=rw&q=${encodeURIComponent(trimmed)}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error("Address search is temporarily unavailable -- try again shortly")
  const rows = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>
  return rows.map(r => ({ lat: Number(r.lat), lng: Number(r.lon), displayName: r.display_name }))
}

// The mirror of geocodeAddress(): turns a pin's coordinates back into a
// readable address, so whoever places or drags a pin can immediately see
// "you've placed this at ..." and confirm it's actually correct, rather
// than trusting a bare pair of numbers. Called once per deliberate
// placement (device location, search result picked, click, drag-end) --
// same "one request per user action" policy as geocodeAddress().
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) return null
  const row = (await res.json()) as { display_name?: string }
  return row.display_name ?? null
}

// A plain link to this exact spot on Google's own public Maps -- lets
// whoever set the pin here cross-check it against Google Maps directly,
// and is the natural jumping-off point when later creating/verifying a
// free Google Business Profile listing for the branch (see this session's
// own explanation: that's a separate, manual step on business.google.com,
// not something this app can do on its own -- Google requires the
// business owner to claim and verify it themselves).
export function googleMapsLinkFor(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
}

// Straight-line (Haversine) distance in kilometers -- free, instant, no API
// call. Good enough for "which sibling branch is likely closest"; not a
// driving-route distance (a real routing API would be a separate, likely
// paid, integration -- not worth it for this use case).
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// A distinctive pharmacy pin -- a rotated-square "teardrop" shape (pure CSS,
// see .pharmacy-pin in index.css) with a pill emoji, instead of Leaflet's
// generic blue marker -- so a glance at the map identifies "there's a
// pharmacy branch here" rather than an anonymous location pin. One shared
// instance since it's stateless and every marker in this app uses the
// identical icon.
export const PHARMACY_ICON = L.divIcon({
  className: "pharmacy-pin-wrap",
  html: "<div class=\"pharmacy-pin\"><span class=\"pharmacy-pin-glyph\">💊</span></div>",
  iconSize: [34, 34],
  iconAnchor: [17, 32],
  popupAnchor: [0, -30],
  tooltipAnchor: [0, -26],
})

// Shared OpenStreetMap tile layer setup -- one place so both map components
// (BranchLocationMap, BranchesMiniMap) stay in sync with OSM's usage policy
// (https://operations.osmfoundation.org/policies/tiles/): a real attribution
// link, no hammering the tile server, and easy to swap the tile URL for a
// different free/self-hosted provider later without touching either page.
export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
export const OSM_ATTRIBUTION = "© <a href=\"https://www.openstreetmap.org/copyright\" target=\"_blank\" rel=\"noreferrer\">OpenStreetMap</a> contributors"

// Free satellite imagery -- no API key, no account, same "fine for this
// app's traffic" tradeoff as the OSM street tiles above (Esri publishes
// this specific layer for exactly this kind of light, non-commercial-scale
// use; a business doing heavy tile volume would eventually want a real
// ArcGIS subscription, which is not this app's situation).
export const ESRI_SATELLITE_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
export const ESRI_SATELLITE_ATTRIBUTION = "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS community"

// The "Map / Satellite" layer switcher every mainstream map product has
// (Google, Bing, Apple Maps) -- Leaflet ships this control natively
// (L.control.layers), it just needs a second tile layer to switch to.
// Labels are passed in by the caller so the control's own text goes through
// this app's i18n like everything else, instead of hardcoded English baked
// into a shared lib file.
export function addBaseLayerToggle(map: L.Map, streetLayer: L.TileLayer, mapLabel: string, satelliteLabel: string): void {
  const satelliteLayer = L.tileLayer(ESRI_SATELLITE_TILE_URL, { attribution: ESRI_SATELLITE_ATTRIBUTION, maxZoom: 19 })
  L.control.layers({ [mapLabel]: streetLayer, [satelliteLabel]: satelliteLayer }).addTo(map)
}

// Native browser Fullscreen API, not a library -- works identically for
// either engine's outer wrapper element (this app puts BOTH map views and
// their own toggle buttons inside one wrapper per component, so the whole
// thing -- controls included -- goes fullscreen together, not just the
// tile canvas). Leaflet caches its container's pixel size and MapLibre's
// canvas needs telling too, so both maps must be explicitly told to
// recompute once the fullscreen transition actually finishes -- see each
// caller's own `fullscreenchange` listener for why that's on a short delay
// rather than done synchronously here.
//
// If this page is itself embedded in an iframe (a preview panel, for
// instance) without that iframe's own `allow="fullscreen"` permission,
// requestFullscreen() rejects instead of doing anything -- onDenied
// surfaces that as a real, visible message instead of the button just
// silently doing nothing, the exact failure mode the 3D loading/error
// states were already built to stop happening elsewhere on this same map.
export function toggleFullscreen(el: HTMLElement, onDenied?: (message: string) => void): void {
  if (document.fullscreenElement === el) {
    void document.exitFullscreen()
    return
  }
  el.requestFullscreen().catch((reason: unknown) => {
    console.error("Fullscreen request failed:", reason)
    onDenied?.("Fullscreen isn't allowed in this preview. Opening the app in its own browser tab (not an embedded preview) usually allows it.")
  })
}

// A subtle pulsing ring drawn around a device-GPS reading's accuracy radius
// -- see BranchLocationMap's own use of this for why (a plain circle alone
// doesn't read as "live signal" the way a soft pulse does, and reusing
// L.circle's own `className` option keeps this a one-line addition on the
// caller's side rather than a new map primitive).
export const ACCURACY_CIRCLE_CLASS = "accuracy-circle-pulse"
