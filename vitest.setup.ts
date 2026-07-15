import { vi } from 'vitest'

// Mock Leaflet — browser-only globals (window, document) are unavailable in jsdom
// without these mocks. This prevents ReferenceError during test imports.
vi.mock('leaflet', () => {
  const mockIcon = vi.fn()
  const mockDivIcon = vi.fn()
  const mockLatLngBounds = vi.fn(() => ({
    extend: vi.fn(),
    isValid: vi.fn(() => true),
  }))

  return {
    default: {
      Icon: mockIcon,
      DivIcon: mockDivIcon,
      LatLngBounds: mockLatLngBounds,
      icon: vi.fn(() => ({})),
      divIcon: vi.fn(() => ({})),
      latLngBounds: vi.fn(() => ({
        extend: vi.fn(),
        isValid: vi.fn(() => true),
      })),
      map: vi.fn(),
      marker: vi.fn(),
      tileLayer: vi.fn(),
    },
    Icon: mockIcon,
    DivIcon: mockDivIcon,
    LatLngBounds: mockLatLngBounds,
    icon: vi.fn(() => ({})),
    divIcon: vi.fn(() => ({})),
    latLngBounds: vi.fn(() => ({
      extend: vi.fn(),
      isValid: vi.fn(() => true),
    })),
    map: vi.fn(),
    marker: vi.fn(),
    tileLayer: vi.fn(),
  }
})

// Mock react-leaflet — all components render as simple divs in test
vi.mock('react-leaflet', () => ({
  MapContainer: vi.fn(({ children }) => children),
  TileLayer: vi.fn(() => null),
  Marker: vi.fn(({ children }) => children),
  Popup: vi.fn(({ children }) => children),
  useMap: vi.fn(() => ({
    fitBounds: vi.fn(),
    setView: vi.fn(),
  })),
}))
