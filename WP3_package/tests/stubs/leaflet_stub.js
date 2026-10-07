/* WP3 test stub for Leaflet 1.9.4 (served via Playwright route; never deployed). */
(function () {
  function chain(extra) {
    var o = extra || {};
    ["addTo", "bindPopup", "setLatLng", "setContent", "openOn", "on", "off", "setView", "setStyle", "setRadius", "openPopup", "closePopup", "fitBounds", "invalidateSize", "removeLayer", "addLayer", "clearLayers", "setIcon", "bringToFront", "remove"].forEach(function (m) {
      if (!o[m]) o[m] = function () { return o; };
    });
    return o;
  }
  window.L = {
    map: function () { var el = { style: {} }; return chain({ getContainer: function () { return el; }, getZoom: function () { return 12; }, getCenter: function () { return { lat: 52.37, lng: 4.895 }; } }); },
    tileLayer: function () { return chain(); },
    layerGroup: function () { return chain(); },
    featureGroup: function () { return chain(); },
    circleMarker: function () { return chain(); },
    marker: function () { return chain(); },
    circle: function () { return chain(); },
    polyline: function () { return chain(); },
    popup: function () { return chain(); },
    divIcon: function () { return {}; },
    icon: function () { return {}; },
    latLng: function (a, b) { return { lat: a, lng: b }; },
    latLngBounds: function () { return chain({ extend: function () { return this; }, isValid: function () { return false; } }); }
  };
})();
