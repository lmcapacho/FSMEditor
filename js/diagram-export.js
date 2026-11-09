/* =========================================================================
 * diagram-export.js - Clean, report-ready diagram export.
 * Exposes the global `DIAGRAMEXPORT` object.
 * ========================================================================= */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PADDING = 36;
  var EMPTY_WIDTH = 800;
  var EMPTY_HEIGHT = 480;

  function removeAll(root, selector) {
    Array.prototype.slice.call(root.querySelectorAll(selector)).forEach(function (node) {
      node.parentNode.removeChild(node);
    });
  }

  function cleanLayer(layer) {
    var copy = layer.cloneNode(true);
    removeAll(copy, '.hit, .halo, .layer-temp');
    Array.prototype.slice.call(copy.querySelectorAll('.selected, .hover')).forEach(function (node) {
      node.classList.remove('selected');
      node.classList.remove('hover');
    });
    return copy;
  }

  function layerBounds(layers) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    layers.forEach(function (layer) {
      if (!layer || !layer.childNodes.length) return;
      try {
        var box = layer.getBBox();
        if (!box.width && !box.height) return;
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      } catch (e) { /* A hidden SVG may not provide a bounding box. */ }
    });
    return minX === Infinity ? null : {
      x: minX - PADDING,
      y: minY - PADDING,
      width: Math.max(1, maxX - minX + PADDING * 2),
      height: Math.max(1, maxY - minY + PADDING * 2)
    };
  }

  function exportStyle() {
    return [
      '.layer-nodes .state .body{fill:#f8fbff;stroke:#2563eb;stroke-width:2}',
      '.layer-nodes .state .init-head{fill:#0891b2;stroke:#ffffff;stroke-width:1;stroke-linejoin:round}',
      '.layer-nodes .state .name{fill:#0f172a;font:600 14px Arial,sans-serif}',
      '.layer-nodes .state .moore{fill:#92400e;font:11px Arial,sans-serif}',
      '.layer-edges .edge .line{fill:none;stroke:#475569;stroke-width:2}',
      '.layer-edges .edge .head{fill:#475569}',
      '.layer-edges .edge-label{fill:#0f172a;font:12px Consolas,"Liberation Mono",monospace}',
      '.layer-edges .edge-label-bg{fill:#ffffff;opacity:.94;rx:3}'
    ].join('');
  }

  function svgData() {
    var canvas = document.getElementById('canvas');
    var edges = canvas && canvas.querySelector('.layer-edges');
    var nodes = canvas && canvas.querySelector('.layer-nodes');
    var bounds = layerBounds([edges, nodes]);
    var width = bounds ? Math.ceil(bounds.width) : EMPTY_WIDTH;
    var height = bounds ? Math.ceil(bounds.height) : EMPTY_HEIGHT;
    var viewBox = bounds ? [bounds.x, bounds.y, bounds.width, bounds.height].join(' ') : ('0 0 ' + width + ' ' + height);
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Finite-state-machine diagram');

    var style = document.createElementNS(SVG_NS, 'style');
    style.textContent = exportStyle();
    svg.appendChild(style);
    var background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('x', bounds ? String(bounds.x) : '0');
    background.setAttribute('y', bounds ? String(bounds.y) : '0');
    background.setAttribute('width', String(bounds ? bounds.width : width));
    background.setAttribute('height', String(bounds ? bounds.height : height));
    background.setAttribute('fill', '#ffffff');
    svg.appendChild(background);
    if (edges) svg.appendChild(cleanLayer(edges));
    if (nodes) svg.appendChild(cleanLayer(nodes));

    return { text: new XMLSerializer().serializeToString(svg), width: width, height: height };
  }

  function svg() {
    return svgData().text;
  }

  function png() {
    var data = svgData();
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([data.text], { type: 'image/svg+xml;charset=utf-8' }));
      var image = new Image();
      image.onload = function () {
        try {
          var scale = 2;
          var canvas = document.createElement('canvas');
          canvas.width = data.width * scale;
          canvas.height = data.height * scale;
          var context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (!blob) { reject(new Error('Could not render the diagram as PNG.')); return; }
            blob.arrayBuffer().then(function (buffer) { resolve(new Uint8Array(buffer)); }, reject);
          }, 'image/png');
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load the diagram for PNG export.'));
      };
      image.src = url;
    });
  }

  global.DIAGRAMEXPORT = { svg: svg, png: png };
}(window));
