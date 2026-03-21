import { useEffect, useMemo, useRef, useState } from "react";
import Feature from "ol/Feature";
import type { Coordinate } from "ol/coordinate";
import type { FeatureLike } from "ol/Feature";
import { defaults as defaultControls } from "ol/control/defaults";
import Point from "ol/geom/Point";
import OlMap from "ol/Map";
import Overlay from "ol/Overlay";
import View from "ol/View";
import { isEmpty as isEmptyExtent } from "ol/extent";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import Fill from "ol/style/Fill";
import Icon from "ol/style/Icon";
import Style from "ol/style/Style";
import Text from "ol/style/Text";
import "./App.css";

type Aircraft = {
  alt_baro?: number | "ground";
  category?: string;
  dbFlags?: number;
  desc?: string;
  flight?: string;
  gs?: number;
  hex: string;
  lat?: number;
  lon?: number;
  r?: string;
  seen_pos?: number;
  t?: string;
  track?: number;
};

type FlightFeedResponse = {
  ac?: Aircraft[];
  now?: number;
};

type RouteLookupResponse = {
  response?: {
    flightroute?: {
      destination?: {
        iata_code?: string;
        icao_code?: string;
        name?: string;
      };
      origin?: {
        iata_code?: string;
        icao_code?: string;
        name?: string;
      };
    };
  };
};

type RouteInfoState =
  | { status: "idle" | "loading" }
  | { destination: string; origin: string; status: "ready" }
  | { message: string; status: "missing" | "error" };

type SelectedFlightDetails = {
  altitude: string;
  callsign: string;
  hex: string;
  position: Coordinate;
  registration: string;
  speed: string;
  track: number;
  type: string;
};

type MapType = "standard" | "dark" | "topo";

const FLIGHT_FEED_URL =
  "https://api.airplanes.live/v2/point/59.9139/10.7522/250";
const REFRESH_INTERVAL_MS = 15000;
const COMMERCIAL_CATEGORIES = new Set(["A2", "A3", "A4", "A5"]);
const FLIGHT_ARROW_COLOR = "#f59e0b";
const SELECTED_FLIGHT_ARROW_COLOR = "#fbbf24";
const INITIAL_LOADER_MESSAGES = [
  "Connecting to flight data source",
  "Synchronizing live ADS-B positions",
  "Filtering commercial traffic",
  "Rendering aircraft on the map",
  "Correlating transponder signals",
  "Projecting live tracks into map coordinates",
  "Indexing nearby aircraft movements",
  "Finalizing the first tactical air picture",
] as const;
let primedFlightsPromise: Promise<Aircraft[]> | null = null;

const createPlaneIconDataUrl = (fillColor: string) => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44">
      <path
        fill="${fillColor}"
        d="M22 4
           C20.8 4 19.9 4.9 19.9 6.1
           V14.4
           L10.8 19
           C9.9 19.5 9.4 20.5 9.6 21.5
           C9.8 22.6 10.8 23.4 11.9 23.4
           H19.9
           V28.1
           L15.7 31.1
           V35.2
           L19.9 33.5
           V38.3
           C19.9 39.5 20.8 40.4 22 40.4
           C23.2 40.4 24.1 39.5 24.1 38.3
           V33.5
           L28.3 35.2
           V31.1
           L24.1 28.1
           V23.4
           H32.1
           C33.2 23.4 34.2 22.6 34.4 21.5
           C34.6 20.5 34.1 19.5 33.2 19
           L24.1 14.4
           V6.1
           C24.1 4.9 23.2 4 22 4Z"
      />
    </svg>
  `;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

function BravoNetLogo() {
  return (
    <div className="brand" aria-label="BravoNET">
      <div className="brand__mark" aria-hidden="true">
        <img
          src="https://bravonet.no/wp-content/uploads/2022/09/RGBWEB-LOGO-BRAVONET_WHITE-01.png"
          alt="BravoNET"
        />
      </div>
      <div className="brand__text">
        <span className="brand__tag">
          We know you are heading for Gran Canaria
        </span>
      </div>
    </div>
  );
}

function createBaseSource(mapType: MapType) {
  if (mapType === "dark") {
    return new XYZ({
      attributions:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
      url: "https://{a-d}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    });
  }

  if (mapType === "topo") {
    return new XYZ({
      attributions:
        'Kart: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> contributors',
      url: "https://{a-c}.tile.opentopomap.org/{z}/{x}/{y}.png",
    });
  }

  return new OSM();
}

function isCommercialFlight(aircraft: Aircraft) {
  if (typeof aircraft.lat !== "number" || typeof aircraft.lon !== "number") {
    return false;
  }

  if (!aircraft.flight?.trim()) {
    return false;
  }

  if (!COMMERCIAL_CATEGORIES.has(aircraft.category ?? "")) {
    return false;
  }

  if (aircraft.alt_baro === "ground") {
    return false;
  }

  if ((aircraft.seen_pos ?? 999) > 30) {
    return false;
  }

  return (aircraft.dbFlags ?? 0) & 1 ? false : true;
}

async function fetchCommercialFlights() {
  const response = await fetch(FLIGHT_FEED_URL);

  if (!response.ok) {
    throw new Error(`Feed svarte med ${response.status}`);
  }

  const data = (await response.json()) as FlightFeedResponse;
  return (data.ac ?? []).filter(isCommercialFlight);
}

function getPrimedFlightsPromise() {
  primedFlightsPromise ??= fetchCommercialFlights();
  return primedFlightsPromise;
}

if (typeof window !== "undefined") {
  void getPrimedFlightsPromise();
}

function createFlightFeature(aircraft: Aircraft) {
  const callsign = aircraft.flight?.trim() ?? aircraft.hex;
  const coordinate = fromLonLat([aircraft.lon!, aircraft.lat!]);

  const feature = new Feature({
    geometry: new Point(coordinate),
  });

  feature.setId(aircraft.hex);
  feature.setProperties({
    altitude:
      typeof aircraft.alt_baro === "number"
        ? `${Math.round(aircraft.alt_baro).toLocaleString("nb-NO")} ft`
        : "Unknown",
    callsign,
    position: coordinate,
    registration: aircraft.r ?? "Unknown",
    speed: typeof aircraft.gs === "number" ? `${Math.round(aircraft.gs)} kt` : "Unknown",
    track: aircraft.track ?? 0,
    type: aircraft.desc ?? aircraft.t ?? "Unknown aircraft type",
  });

  return feature;
}

function buildSelectedFlightDetails(feature: Feature): SelectedFlightDetails {
  return {
    altitude: String(feature.get("altitude") ?? "Unknown"),
    callsign: String(feature.get("callsign") ?? feature.getId() ?? "Unknown"),
    hex: String(feature.getId() ?? ""),
    position: feature.get("position") as Coordinate,
    registration: String(feature.get("registration") ?? "Unknown"),
    speed: String(feature.get("speed") ?? "Unknown"),
    track: Number(feature.get("track") ?? 0),
    type: String(feature.get("type") ?? "Unknown aircraft type"),
  };
}

function getRouteFieldValue(
  routeInfoState: RouteInfoState,
  field: "origin" | "destination",
) {
  if (routeInfoState.status === "ready") {
    return routeInfoState[field];
  }

  if (routeInfoState.status === "loading") {
    return "Loading...";
  }

  return "Unavailable";
}

function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const popupElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const popupOverlayRef = useRef<Overlay | null>(null);
  const baseLayerRef = useRef<TileLayer | null>(null);
  const flightsLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const flightsSourceRef = useRef<VectorSource | null>(null);
  const hasAutoFittedRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const selectedFlightHexRef = useRef<string | null>(null);
  const styleCacheRef = useRef(new globalThis.Map<string, Style[]>());
  const [flightCount, setFlightCount] = useState(0);
  const [mapType, setMapType] = useState<MapType>("dark");
  const [isInitialFlightLoad, setIsInitialFlightLoad] = useState(true);
  const [loaderMessageIndex, setLoaderMessageIndex] = useState(0);
  const [selectedFlight, setSelectedFlight] =
    useState<SelectedFlightDetails | null>(null);
  const [routeInfoState, setRouteInfoState] = useState<RouteInfoState>({
    status: "idle",
  });

  const mapTypeOptions = useMemo(
    () => [
      { label: "Standard", value: "standard" as const },
      { label: "Dark", value: "dark" as const },
      { label: "Topo", value: "topo" as const },
    ],
    [],
  );

  useEffect(() => {
    selectedFlightHexRef.current = selectedFlight?.hex ?? null;
    popupOverlayRef.current?.setPosition(selectedFlight?.position);
    flightsLayerRef.current?.changed();
  }, [selectedFlight]);

  useEffect(() => {
    if (!isInitialFlightLoad) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setLoaderMessageIndex((currentIndex) =>
        currentIndex === INITIAL_LOADER_MESSAGES.length - 1
          ? 0
          : currentIndex + 1,
      );
    }, 1600);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isInitialFlightLoad]);

  useEffect(() => {
    if (!selectedFlight) {
      setRouteInfoState({ status: "idle" });
      return;
    }

    const callsign = selectedFlight.callsign.trim().replace(/\s+/g, "");
    if (!callsign) {
      setRouteInfoState({
        message: "Route information is unavailable for this flight.",
        status: "missing",
      });
      return;
    }

    const abortController = new AbortController();
    setRouteInfoState({ status: "loading" });

    const loadRoute = async () => {
      try {
        const response = await fetch(
          `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
          { signal: abortController.signal },
        );

        if (response.status === 404) {
          setRouteInfoState({
            message: "Route information is unavailable for this flight.",
            status: "missing",
          });
          return;
        }

        if (!response.ok) {
          throw new Error("Unable to fetch route information right now.");
        }

        const data = (await response.json()) as RouteLookupResponse;
        const route = data.response?.flightroute;
        const originCode = route?.origin?.iata_code ?? route?.origin?.icao_code;
        const destinationCode =
          route?.destination?.iata_code ?? route?.destination?.icao_code;
        const originLabel = route?.origin?.name
          ? `${originCode ? `${originCode} - ` : ""}${route.origin.name}`
          : originCode;
        const destinationLabel = route?.destination?.name
          ? `${destinationCode ? `${destinationCode} - ` : ""}${route.destination.name}`
          : destinationCode;

        if (!originLabel && !destinationLabel) {
          setRouteInfoState({
            message: "Route information is unavailable for this flight.",
            status: "missing",
          });
          return;
        }

        setRouteInfoState({
          destination: destinationLabel ?? "Unknown destination",
          origin: originLabel ?? "Unknown origin",
          status: "ready",
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        setRouteInfoState({
          message:
            error instanceof Error
              ? error.message
              : "Unable to fetch route information right now.",
          status: "error",
        });
      }
    };

    void loadRoute();

    return () => {
      abortController.abort();
    };
  }, [selectedFlight]);

  useEffect(() => {
    if (!mapElementRef.current || !popupElementRef.current) {
      return;
    }

    if (!flightsSourceRef.current) {
      flightsSourceRef.current = new VectorSource();
    }

    if (!baseLayerRef.current) {
      baseLayerRef.current = new TileLayer({
        source: createBaseSource("dark"),
      });
    }

    if (!flightsLayerRef.current) {
      flightsLayerRef.current = new VectorLayer({
        source: flightsSourceRef.current,
        style: (feature) => {
          const callsign = String(feature.get("callsign") ?? "");
          const track = Number(feature.get("track") ?? 0);
          const isSelected =
            String(feature.getId() ?? "") === selectedFlightHexRef.current;
          const cacheKey = `${callsign}-${Math.round(track / 5)}-${isSelected ? "selected" : "default"}`;
          const cachedStyle = styleCacheRef.current.get(cacheKey);

          if (cachedStyle) {
            return cachedStyle;
          }

          const radians = (track * Math.PI) / 180;
          const aircraftColor = isSelected
            ? SELECTED_FLIGHT_ARROW_COLOR
            : FLIGHT_ARROW_COLOR;
          const aircraftStyle = new Style({
            image: new Icon({
              src: createPlaneIconDataUrl(aircraftColor),
              anchor: [0.5, 0.5],
              rotateWithView: true,
              rotation: radians,
              scale: isSelected ? 1.06 : 0.92,
            }),
          });

          const labelStyle = new Style({
            text: new Text({
              text: callsign,
              offsetY: 22,
              padding: [2, 4, 2, 4],
              fill: new Fill({ color: "#f8fafc" }),
              backgroundFill: new Fill({
                color: isSelected
                  ? "rgba(15, 23, 42, 0.95)"
                  : "rgba(15, 23, 42, 0.82)",
              }),
              font: "600 11px Inter, system-ui, sans-serif",
            }),
          });

          const styles = [aircraftStyle, labelStyle];
          styleCacheRef.current.set(cacheKey, styles);
          return styles;
        },
      });
    }

    if (!mapRef.current) {
      mapRef.current = new OlMap({
        controls: defaultControls({ zoom: false }),
        layers: [baseLayerRef.current, flightsLayerRef.current],
        view: new View({
          center: fromLonLat([10.7522, 59.9139]),
          zoom: 5,
        }),
      });
    }

    if (!popupOverlayRef.current) {
      popupOverlayRef.current = new Overlay({
        autoPan: {
          animation: {
            duration: 180,
          },
        },
        element: popupElementRef.current,
        offset: [40, 0],
        positioning: "center-left",
      });
      mapRef.current.addOverlay(popupOverlayRef.current);
    }

    const map = mapRef.current;
    map.setTarget(mapElementRef.current);
    map.updateSize();

    const handleMapClick = (event: { pixel: number[] }) => {
      const hit = map.forEachFeatureAtPixel(
        event.pixel,
        (featureLike: FeatureLike, layer) =>
          layer === flightsLayerRef.current
            ? (featureLike as Feature)
            : undefined,
      ) as Feature | undefined;

      if (!hit) {
        setSelectedFlight(null);
        return;
      }

      setSelectedFlight(buildSelectedFlightDetails(hit));
    };

    map.on("singleclick", handleMapClick);

    return () => {
      map.un("singleclick", handleMapClick);
      if (popupOverlayRef.current) {
        map.removeOverlay(popupOverlayRef.current);
        popupOverlayRef.current = null;
      }
      map.setTarget(undefined);
    };
  }, []);

  useEffect(() => {
    if (!baseLayerRef.current) {
      return;
    }

    baseLayerRef.current.setSource(createBaseSource(mapType));
  }, [mapType]);

  useEffect(() => {
    if (!flightsSourceRef.current) {
      return;
    }

    let isCancelled = false;

    const refreshFlights = async (usePrimedFlights = false) => {
      if (isRefreshingRef.current) {
        return;
      }

      isRefreshingRef.current = true;

      try {
        const flights = usePrimedFlights
          ? await getPrimedFlightsPromise()
          : await fetchCommercialFlights();
        const features = flights.map(createFlightFeature);

        if (isCancelled || !flightsSourceRef.current) {
          return;
        }

        flightsSourceRef.current.clear(true);
        flightsSourceRef.current.addFeatures(features);
        const extent = flightsSourceRef.current.getExtent();

        if (
          !hasAutoFittedRef.current &&
          mapRef.current &&
          features.length > 0 &&
          extent &&
          !isEmptyExtent(extent)
        ) {
          mapRef.current.getView().fit(extent, {
            padding: [110, 40, 40, 40],
            maxZoom: 6,
          });
          hasAutoFittedRef.current = true;
        }

        const selectedHex = selectedFlightHexRef.current;
        if (selectedHex) {
          const selectedFeature = features.find(
            (feature) => String(feature.getId() ?? "") === selectedHex,
          );

          if (selectedFeature) {
            const nextSelection = buildSelectedFlightDetails(selectedFeature);
            setSelectedFlight(nextSelection);
          } else {
            setSelectedFlight(null);
          }
        }

        setFlightCount(features.length);
        setIsInitialFlightLoad(false);
        flightsLayerRef.current?.changed();
      } catch {
        // Keep current map state when refresh fails instead of surfacing noisy fetch banners.
      } finally {
        if (usePrimedFlights) {
          primedFlightsPromise = null;
        }
        isRefreshingRef.current = false;
      }
    };

    void refreshFlights(true);
    const intervalId = window.setInterval(() => {
      void refreshFlights();
    }, REFRESH_INTERVAL_MS);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const routeMessage =
    routeInfoState.status === "missing" || routeInfoState.status === "error"
      ? routeInfoState.message
      : null;

  return (
    <main className="app-shell">
      <section className="map-shell">
        <header className="topbar">
          <BravoNetLogo />

          <div className="topbar__controls">
            <div className="flight-pill">
              <span>Flights on map</span>
              <strong>{flightCount}</strong>
            </div>

            <label className="map-type-switcher">
              <span>Map type</span>
              <select
                value={mapType}
                onChange={(event) => {
                  setMapType(event.target.value as MapType);
                }}
              >
                {mapTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        {isInitialFlightLoad ? (
          <div className="flight-loader" role="status" aria-live="polite">
            <div className="flight-loader__panel">
              <div className="flight-loader__spinner" aria-hidden="true" />
              <p className="flight-loader__eyebrow">
                BravoNET is starting up the engine...
              </p>
              <h2>{INITIAL_LOADER_MESSAGES[loaderMessageIndex]}</h2>
              <p className="flight-loader__hint">
                Validating telemetry, normalizing tracks, and preparing the
                first aircraft layer.
              </p>
            </div>
          </div>
        ) : null}

        <div
          ref={mapElementRef}
          className="map"
          role="region"
          aria-label="Map with commercial flight positions"
        />

        <div
          ref={popupElementRef}
          className={`flight-popup ${selectedFlight ? "is-open" : ""}`}
          role="dialog"
          aria-label="Selected flight details"
        >
          {selectedFlight ? (
            <>
              <button
                type="button"
                className="flight-popup__close"
                onClick={() => {
                  setSelectedFlight(null);
                }}
                aria-label="Close popup"
              >
                x
              </button>

              <div className="flight-popup__header">
                <h3>{selectedFlight.callsign}</h3>
                <p>{selectedFlight.registration}</p>
              </div>

              <div className="flight-popup__details">
                <div className="flight-popup__row flight-popup__row--route">
                  <div className="flight-popup__detail">
                    <span>From</span>
                    <strong>{getRouteFieldValue(routeInfoState, "origin")}</strong>
                  </div>
                  <div className="flight-popup__detail">
                    <span>To</span>
                    <strong>{getRouteFieldValue(routeInfoState, "destination")}</strong>
                  </div>
                </div>

                <div className="flight-popup__row flight-popup__row--metrics">
                  <div className="flight-popup__detail">
                    <span>Altitude</span>
                    <strong>{selectedFlight.altitude}</strong>
                  </div>
                  <div className="flight-popup__detail">
                    <span>Speed</span>
                    <strong>{selectedFlight.speed}</strong>
                  </div>
                  <div className="flight-popup__detail">
                    <span>Heading</span>
                    <strong>{Math.round(selectedFlight.track)} deg</strong>
                  </div>
                </div>
              </div>

              {routeMessage ? (
                <p className="flight-popup__route-note">{routeMessage}</p>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

export default App;
