import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import Feature from "ol/Feature";
import type { Coordinate } from "ol/coordinate";
import type { FeatureLike } from "ol/Feature";
import { defaults as defaultControls } from "ol/control/defaults";
import Point from "ol/geom/Point";
import OlMap from "ol/Map";
import Overlay from "ol/Overlay";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, transform } from "ol/proj";
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
type ViewMode = "2d" | "3d";

const FLIGHT_FEED_URL = "https://api.airplanes.live/v2/point/62.0/15.0/900";
const REFRESH_INTERVAL_MS = 15000;
const COMMERCIAL_CATEGORIES = new Set(["A2", "A3", "A4", "A5"]);
const FLIGHT_ARROW_COLOR = "#f59e0b";
const SELECTED_FLIGHT_ARROW_COLOR = "#fbbf24";
const NORWAY_START_CENTER = [11.5, 64.4] as const;
const NORWAY_START_ZOOM = 4.9;
const NORWAY_START_3D_VIEW = {
  destination: Cesium.Rectangle.fromDegrees(4.0, 57.4, 31.5, 71.2),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-85),
    roll: 0,
  },
} as const;
const INITIAL_LOADER_MESSAGES = [
  "Connecting to flight data source",
  "Synchronizing live ADS-B positions",
  "Filtering commercial traffic",
  "Rendering aircraft on the map",
  "Correlating transponder signals",
  "Projecting live tracks into map",
  "Indexing nearby aircraft movements",
  "Finalizing the first tactical air picture",
] as const;
let primedFlightsPromise: Promise<Aircraft[]> | null = null;

const createPlaneIconDataUrl = (fillColor: string) => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="${fillColor}"><path d="M280-80v-100l120-84v-144L80-280v-120l320-224v-176q0-33 23.5-56.5T480-880q33 0 56.5 23.5T560-800v176l320 224v120L560-408v144l120 84v100l-200-60-200 60Z"/></svg>
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

function altitudeFeetToMeters(altitude: Aircraft["alt_baro"]) {
  return typeof altitude === "number" ? Math.max(0, altitude * 0.3048) : 0;
}

function createCesiumImageryProvider(mapType: MapType) {
  if (mapType === "dark") {
    return new Cesium.UrlTemplateImageryProvider({
      credit: "OpenStreetMap contributors, CARTO",
      subdomains: ["a", "b", "c", "d"],
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    });
  }

  if (mapType === "topo") {
    return new Cesium.UrlTemplateImageryProvider({
      credit: "OpenTopoMap contributors",
      subdomains: ["a", "b", "c"],
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    });
  }

  return new Cesium.OpenStreetMapImageryProvider({
    credit: "OpenStreetMap contributors",
    url: "https://tile.openstreetmap.org/",
  });
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
  const altitudeMeters = altitudeFeetToMeters(aircraft.alt_baro);
  const coordinate = transform(
    [aircraft.lon!, aircraft.lat!, altitudeMeters],
    "EPSG:4326",
    "EPSG:3857",
  );

  const feature = new Feature({
    geometry: new Point(coordinate),
  });

  feature.setId(aircraft.hex);
  feature.setProperties({
    altitude:
      typeof aircraft.alt_baro === "number"
        ? `${Math.round(aircraft.alt_baro).toLocaleString("nb-NO")} ft`
        : "Unknown",
    altitudeMeters,
    callsign,
    position: coordinate,
    registration: aircraft.r ?? "Unknown",
    speed:
      typeof aircraft.gs === "number"
        ? `${Math.round(aircraft.gs)} kt`
        : "Unknown",
    track: aircraft.track ?? 0,
    type: aircraft.desc ?? aircraft.t ?? "Unknown aircraft type",
  });

  return feature;
}

function buildSelectedFlightDetailsFromAircraft(
  aircraft: Aircraft,
): SelectedFlightDetails {
  const altitudeMeters = altitudeFeetToMeters(aircraft.alt_baro);

  return {
    altitude:
      typeof aircraft.alt_baro === "number"
        ? `${Math.round(aircraft.alt_baro).toLocaleString("nb-NO")} ft`
        : "Unknown",
    callsign: aircraft.flight?.trim() ?? aircraft.hex,
    hex: aircraft.hex,
    position: transform(
      [aircraft.lon!, aircraft.lat!, altitudeMeters],
      "EPSG:4326",
      "EPSG:3857",
    ),
    registration: aircraft.r ?? "Unknown",
    speed:
      typeof aircraft.gs === "number"
        ? `${Math.round(aircraft.gs)} kt`
        : "Unknown",
    track: aircraft.track ?? 0,
    type: aircraft.desc ?? aircraft.t ?? "Unknown aircraft type",
  };
}

function extractFlightHexFromEntityId(entityId: string) {
  if (entityId.startsWith("flight-stem-")) {
    return entityId.slice("flight-stem-".length);
  }

  if (entityId.startsWith("flight-")) {
    return entityId.slice("flight-".length);
  }

  return null;
}

function extractEntityIdFromPickResult(
  pickedObject: Cesium.Scene | Cesium.Cesium3DTileFeature | unknown,
) {
  if (!pickedObject || typeof pickedObject !== "object") {
    return null;
  }

  const directId =
    "id" in pickedObject
      ? (pickedObject as { id?: unknown }).id
      : null;
  if (typeof directId === "string") {
    return directId;
  }
  if (
    directId &&
    typeof directId === "object" &&
    "id" in directId &&
    typeof (directId as { id?: unknown }).id === "string"
  ) {
    return (directId as { id: string }).id;
  }

  const primitive =
    "primitive" in pickedObject
      ? (pickedObject as { primitive?: unknown }).primitive
      : null;
  if (!primitive || typeof primitive !== "object" || !("id" in primitive)) {
    return null;
  }

  const primitiveId = (primitive as { id?: unknown }).id;
  if (typeof primitiveId === "string") {
    return primitiveId;
  }
  if (
    primitiveId &&
    typeof primitiveId === "object" &&
    "id" in primitiveId &&
    typeof (primitiveId as { id?: unknown }).id === "string"
  ) {
    return (primitiveId as { id: string }).id;
  }

  return null;
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
  const cesiumElementRef = useRef<HTMLDivElement | null>(null);
  const popupElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<OlMap | null>(null);
  const cesiumViewerRef = useRef<Cesium.Viewer | null>(null);
  const latestFlightsRef = useRef<Aircraft[]>([]);
  const popupOverlayRef = useRef<Overlay | null>(null);
  const baseLayerRef = useRef<TileLayer | null>(null);
  const flightsLayerRef = useRef<VectorLayer<VectorSource> | null>(null);
  const flightsSourceRef = useRef<VectorSource | null>(null);
  const isRefreshingRef = useRef(false);
  const selectedFlightHexRef = useRef<string | null>(null);
  const styleCacheRef = useRef(new globalThis.Map<string, Style[]>());
  const [mapType, setMapType] = useState<MapType>("dark");
  const [viewMode, setViewMode] = useState<ViewMode>("3d");
  const [isInitialFlightLoad, setIsInitialFlightLoad] = useState(true);
  const [loaderMessageIndex, setLoaderMessageIndex] = useState(0);
  const [selectedFlight, setSelectedFlight] =
    useState<SelectedFlightDetails | null>(null);
  const [cesiumPopupPosition, setCesiumPopupPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
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
  const viewModeOptions = useMemo(
    () => [
      { label: "2D", value: "2d" as const },
      { label: "3D", value: "3d" as const },
    ],
    [],
  );
  const is3DMode = viewMode === "3d";
  const routeMessage =
    routeInfoState.status === "missing" || routeInfoState.status === "error"
      ? routeInfoState.message
      : null;

  const renderFlightPopupContent = useCallback(() => {
    if (!selectedFlight) {
      return null;
    }

    return (
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
              <strong>
                {getRouteFieldValue(routeInfoState, "destination")}
              </strong>
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
    );
  }, [routeInfoState, routeMessage, selectedFlight]);

  const applyCesiumBaseLayer = useCallback((nextMapType: MapType) => {
    const viewer = cesiumViewerRef.current;
    if (!viewer) {
      return;
    }

    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      createCesiumImageryProvider(nextMapType),
    );
    viewer.scene.requestRender();
  }, []);

  const syncCesiumFlights = useCallback((flights: Aircraft[]) => {
    const viewer = cesiumViewerRef.current;
    if (!viewer) {
      return;
    }

    const selectedHex = selectedFlightHexRef.current;
    const activeEntityIds = new Set<string>();

    for (const aircraft of flights) {
      const altitudeMeters = altitudeFeetToMeters(aircraft.alt_baro);
      const callsign = aircraft.flight?.trim() ?? aircraft.hex;
      const track = aircraft.track ?? 0;
      const isSelected = aircraft.hex === selectedHex;
      const aircraftEntityId = `flight-${aircraft.hex}`;
      const stemEntityId = `flight-stem-${aircraft.hex}`;
      const position = Cesium.Cartesian3.fromDegrees(
        aircraft.lon!,
        aircraft.lat!,
        altitudeMeters,
      );
      const stemPositions = Cesium.Cartesian3.fromDegreesArrayHeights([
        aircraft.lon!,
        aircraft.lat!,
        0,
        aircraft.lon!,
        aircraft.lat!,
        altitudeMeters,
      ]);
      const aircraftEntity = viewer.entities.getById(aircraftEntityId);
      const stemEntity = viewer.entities.getById(stemEntityId);
      const imageSource = createPlaneIconDataUrl(
        isSelected ? SELECTED_FLIGHT_ARROW_COLOR : FLIGHT_ARROW_COLOR,
      );

      if (aircraftEntity) {
        aircraftEntity.position = new Cesium.ConstantPositionProperty(position);
        if (aircraftEntity.billboard) {
          aircraftEntity.billboard.image = new Cesium.ConstantProperty(
            imageSource,
          );
          aircraftEntity.billboard.rotation = new Cesium.ConstantProperty(
            (track * Math.PI) / 180,
          );
          aircraftEntity.billboard.scale = new Cesium.ConstantProperty(
            isSelected ? 1.08 : 0.96,
          );
        }
        if (aircraftEntity.label) {
          aircraftEntity.label.text = new Cesium.ConstantProperty(callsign);
          aircraftEntity.label.backgroundColor = new Cesium.ConstantProperty(
            isSelected
              ? Cesium.Color.fromCssColorString("rgba(15, 23, 42, 0.95)")
              : Cesium.Color.fromCssColorString("rgba(15, 23, 42, 0.82)"),
          );
        }
      } else {
        viewer.entities.add({
          billboard: {
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            image: imageSource,
            rotation: (track * Math.PI) / 180,
            scale: isSelected ? 1.08 : 0.96,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
          },
          id: aircraftEntityId,
          label: {
            backgroundColor: isSelected
              ? Cesium.Color.fromCssColorString("rgba(15, 23, 42, 0.95)")
              : Cesium.Color.fromCssColorString("rgba(15, 23, 42, 0.82)"),
            fillColor: Cesium.Color.WHITE,
            font: "600 14px Inter, system-ui, sans-serif",
            pixelOffset: new Cesium.Cartesian2(0, 26),
            show: true,
            showBackground: true,
            style: Cesium.LabelStyle.FILL,
            text: callsign,
          },
          position,
        });
      }

      if (stemEntity) {
        if (stemEntity.polyline) {
          stemEntity.polyline.positions = new Cesium.ConstantProperty(
            stemPositions,
          );
          stemEntity.polyline.material = new Cesium.ColorMaterialProperty(
            isSelected
              ? Cesium.Color.fromCssColorString("rgba(251, 191, 36, 0.9)")
              : Cesium.Color.fromCssColorString("rgba(148, 163, 184, 0.55)"),
          );
          stemEntity.polyline.width = new Cesium.ConstantProperty(
            isSelected ? 3.2 : 1.6,
          );
        }
      } else {
        viewer.entities.add({
          id: stemEntityId,
          polyline: {
            material: new Cesium.ColorMaterialProperty(
              isSelected
                ? Cesium.Color.fromCssColorString("rgba(251, 191, 36, 0.9)")
                : Cesium.Color.fromCssColorString("rgba(148, 163, 184, 0.55)"),
            ),
            positions: stemPositions,
            width: isSelected ? 3.2 : 1.6,
          },
        });
      }

      activeEntityIds.add(aircraftEntityId);
      activeEntityIds.add(stemEntityId);
    }

    const staleEntities: Cesium.Entity[] = [];
    viewer.entities.values.forEach((entity) => {
      if (
        typeof entity.id === "string" &&
        entity.id.startsWith("flight") &&
        !activeEntityIds.has(entity.id)
      ) {
        staleEntities.push(entity);
      }
    });

    staleEntities.forEach((entity) => {
      viewer.entities.remove(entity);
    });
    viewer.scene.requestRender();
  }, []);

  useEffect(() => {
    selectedFlightHexRef.current = selectedFlight?.hex ?? null;
    popupOverlayRef.current?.setPosition(selectedFlight?.position);
    flightsLayerRef.current?.changed();
    syncCesiumFlights(latestFlightsRef.current);
    if (!selectedFlight || !is3DMode) {
      setCesiumPopupPosition(null);
    }
  }, [is3DMode, selectedFlight, syncCesiumFlights]);

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
          center: fromLonLat([...NORWAY_START_CENTER]),
          zoom: NORWAY_START_ZOOM,
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
    if (!cesiumElementRef.current || cesiumViewerRef.current) {
      return;
    }

    const viewer = new Cesium.Viewer(cesiumElementRef.current, {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      shouldAnimate: false,
      timeline: false,
    });
    viewer.scene.globe.enableLighting = true;
    viewer.scene.requestRenderMode = true;
    viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    cesiumViewerRef.current = viewer;
    applyCesiumBaseLayer(mapType);

    return () => {
      viewer.destroy();
      cesiumViewerRef.current = null;
    };
  }, [applyCesiumBaseLayer, mapType]);

  useEffect(() => {
    const viewer = cesiumViewerRef.current;
    if (!viewer) {
      return;
    }

    const clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );

    const handleCesiumClick = (event: { position: Cesium.Cartesian2 }) => {
      if (!is3DMode) {
        return;
      }

      const pickedObject = viewer.scene.pick(event.position);
      const entityId = extractEntityIdFromPickResult(pickedObject);

      if (!entityId) {
        setSelectedFlight(null);
        viewer.scene.requestRender();
        return;
      }

      const selectedHex = extractFlightHexFromEntityId(entityId);
      if (!selectedHex) {
        setSelectedFlight(null);
        viewer.scene.requestRender();
        return;
      }

      const aircraft = latestFlightsRef.current.find(
        (flight) => flight.hex === selectedHex,
      );
      if (!aircraft) {
        setSelectedFlight(null);
        viewer.scene.requestRender();
        return;
      }

      setSelectedFlight(buildSelectedFlightDetailsFromAircraft(aircraft));
      viewer.scene.requestRender();
    };

    clickHandler.setInputAction(
      handleCesiumClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    return () => {
      clickHandler.destroy();
    };
  }, [is3DMode]);

  useEffect(() => {
    const viewer = cesiumViewerRef.current;
    if (!viewer || !is3DMode || !selectedFlight) {
      return;
    }

    const updatePopupPosition = () => {
      const aircraft = latestFlightsRef.current.find(
        (flight) => flight.hex === selectedFlight.hex,
      );
      if (!aircraft) {
        setCesiumPopupPosition(null);
        return;
      }

      const cartesian = Cesium.Cartesian3.fromDegrees(
        aircraft.lon!,
        aircraft.lat!,
        altitudeFeetToMeters(aircraft.alt_baro),
      );
      const coordinates = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        cartesian,
      );

      if (!coordinates) {
        setCesiumPopupPosition(null);
        return;
      }

      setCesiumPopupPosition({
        left: coordinates.x + 28,
        top: coordinates.y - 16,
      });
    };

    updatePopupPosition();
    viewer.scene.postRender.addEventListener(updatePopupPosition);

    return () => {
      viewer.scene.postRender.removeEventListener(updatePopupPosition);
    };
  }, [is3DMode, selectedFlight]);

  useEffect(() => {
    if (!baseLayerRef.current) {
      return;
    }

    baseLayerRef.current.setSource(createBaseSource(mapType));
    applyCesiumBaseLayer(mapType);
  }, [applyCesiumBaseLayer, mapType]);

  useEffect(() => {
    if (!mapRef.current || !cesiumViewerRef.current) {
      return;
    }

    if (!is3DMode) {
      mapRef.current.updateSize();
      return;
    }

    setSelectedFlight(null);
    cesiumViewerRef.current.camera.flyTo({
      destination: NORWAY_START_3D_VIEW.destination,
      duration: 0.9,
      orientation: NORWAY_START_3D_VIEW.orientation,
    });
    syncCesiumFlights(latestFlightsRef.current);
  }, [is3DMode, syncCesiumFlights]);

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
        latestFlightsRef.current = flights;

        if (isCancelled || !flightsSourceRef.current) {
          return;
        }

        flightsSourceRef.current.clear(true);
        flightsSourceRef.current.addFeatures(features);
        syncCesiumFlights(flights);

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
  }, [syncCesiumFlights]);

  return (
    <main className="app-shell">
      <section className="map-shell">
        <header className="topbar">
          <BravoNetLogo />

          <div className="topbar__controls">
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

            <label className="view-mode-switcher">
              <span>View</span>
              <select
                value={viewMode}
                onChange={(event) => {
                  setViewMode(event.target.value as ViewMode);
                }}
              >
                {viewModeOptions.map((option) => (
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
          className={`map ${is3DMode ? "map--hidden" : ""}`}
          role="region"
          aria-label="Map with commercial flight positions"
        />

        <div
          ref={cesiumElementRef}
          className={`map map--cesium ${is3DMode ? "is-active" : ""}`}
          role="region"
          aria-label="3D map with commercial flight positions"
        />

        <div
          ref={popupElementRef}
          className={`flight-popup ${selectedFlight && !is3DMode ? "is-open" : ""}`}
          role="dialog"
          aria-label="Selected flight details"
        >
          {renderFlightPopupContent()}
        </div>

        <div
          className={`flight-popup flight-popup--floating ${
            selectedFlight && is3DMode && cesiumPopupPosition ? "is-open" : ""
          }`}
          style={
            cesiumPopupPosition
              ? {
                  left: `${cesiumPopupPosition.left}px`,
                  top: `${cesiumPopupPosition.top}px`,
                }
              : undefined
          }
          role="dialog"
          aria-label="Selected flight details in 3D"
        >
          {is3DMode ? renderFlightPopupContent() : null}
        </div>
      </section>
    </main>
  );
}

export default App;
