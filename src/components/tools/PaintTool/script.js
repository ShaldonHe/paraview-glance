import { mapState } from 'vuex';

import macro from 'vtk.js/Sources/macro';
import vtkPaintWidget from 'vtk.js/Sources/Widgets/Widgets3D/PaintWidget';
import vtkPaintFilter from 'vtk.js/Sources/Filters/General/PaintFilter';
import { ViewTypes } from 'vtk.js/Sources/Widgets/Core/WidgetManager/Constants';

import vtkLabelMap from 'paraview-glance/src/vtk/LabelMap';
import ReaderFactory from 'paraview-glance/src/io/ReaderFactory';
import utils from 'paraview-glance/src/utils';
import PalettePicker from 'paraview-glance/src/components/widgets/PalettePicker';
import PopUp from 'paraview-glance/src/components/widgets/PopUp';
import { SPECTRAL } from 'paraview-glance/src/palette';

const { vtkErrorMacro } = macro;
const { makeSubManager, forAllViews } = utils;

// ----------------------------------------------------------------------------

function linkInteractors(sourceView, destView) {
  const srcInt = sourceView.getInteractor();
  const dstInt = destView.getInteractor();
  const sync = {}; // dummy unique object for animation requesting

  let startSub;

  if (srcInt.isAnimating()) {
    dstInt.requestAnimation(sync);
  } else {
    startSub = srcInt.onStartAnimation(() => {
      dstInt.requestAnimation(sync);
    });
  }

  const endSub = srcInt.onEndAnimation(() => {
    dstInt.cancelAnimation(sync);
    // setTimeout(dstInt.render, 0);
  });

  return {
    unsubscribe: () => {
      startSub && startSub.unsubscribe();
      endSub.unsubscribe();
    },
  };
}

// ----------------------------------------------------------------------------

export default {
  name: 'PaintTool',
  components: {
    PalettePicker,
    PopUp,
  },
  data() {
    return {
      master: null,
      labelmapProxy: null,
      // for view purpose only
      // [ { label, color, opacity }, ... ], sorted by label asc
      colormapArray: [],
      widget: null,
      enabled: false,
      label: 1,
      radius: 5,
      palette: SPECTRAL,
      nextPaletteColorIdx: 0,
    };
  },
  computed: mapState(['proxyManager']),
  mounted() {
    this.widget = vtkPaintWidget.newInstance();
    this.widget.setRadius(this.radius);
    this.filter = vtkPaintFilter.newInstance();
    this.filter.setRadius(this.radius);
    this.filter.setLabel(this.label);

    this.view3D = null;

    this.subs = [];
    this.labelmapSub = makeSubManager();
  },
  beforeDestroy() {
    this.view3D = null;
    this.labelmapSub.unsub();
    while (this.subs.length) {
      this.subs.pop().unsubscribe();
    }
  },
  watch: {
    label(label) {
      if (label < 0) {
        this.label = 0;
      } else if (label !== Math.round(label)) {
        // also handles case if label is a numerical string
        this.label = Math.round(label);
      }
      this.filter.setLabel(this.label);
    },
    radius(radius) {
      if (radius < 0) {
        this.radius = 0;
      } else if (radius !== Math.round(radius)) {
        // also handles case if label is a numerical string
        this.radius = Math.round(radius);
      }
      this.filter.setRadius(this.radius);
      this.widget.setRadius(this.radius);
    },
    enabled(enabled) {
      if (enabled) {
        this.addWidgetToViews();
      } else {
        this.removeWidgetFromViews();

        while (this.subs.length) {
          this.subs.pop().unsubscribe();
        }
      }

      this.proxyManager.renderAllViews();
    },
  },
  methods: {
    getNextColorArray() {
      const color = this.palette[this.nextPaletteColorIdx];
      this.nextPaletteColorIdx = (this.nextPaletteColorIdx + 1) % this.palette.length;
      return this.fromHex(color);
    },
    asHex(colorArray) {
      return (
        '#' + colorArray.map((c) => ('00' + c.toString(16)).slice(-2)).join('')
      );
    },
    fromHex(colorStr) {
      const hex = colorStr.slice(1); // remove leading #
      const colorArray = [];
      for (let i = 0; i < hex.length; i += 2) {
        colorArray.push(Number.parseInt(hex.slice(i, i + 2), 16));
      }
      return colorArray;
    },
    getVolumes() {
      return this.proxyManager
        .getSources()
        .filter((s) => s.getType() === 'vtkImageData')
        .map((s) => ({
          name: s.getName(),
          source: s,
        }));
    },
    getLabelmaps() {
      const labelmaps = this.proxyManager
        .getSources()
        .filter((s) => s.getType() === 'vtkLabelMap')
        .map((s) => ({
          name: s.getName(),
          source: s,
        }));

      labelmaps.unshift({
        name: 'Create new labelmap',
        source: 'CREATE_NEW_LABELMAP',
      });
      return labelmaps;
    },
    setMasterVolume(source) {
      this.master = source;
      this.filter.setBackgroundImage(source.getDataset());

      if (this.enabled) {
        // refresh widgets when backing image changes
        this.removeWidgetFromViews();
        this.addWidgetToViews();
      }
    },
    setLabelMap(selected) {
      if (selected === 'CREATE_NEW_LABELMAP') {
        const paintImage = this.filter.getOutputData();
        /* eslint-disable-next-line import/no-named-as-default-member */
        const labelmap = vtkLabelMap.newInstance({
          imageRepresentation: paintImage,
        });

        ReaderFactory.registerReadersToProxyManager(
          [
            {
              name: 'Painting Labelmap',
              dataset: labelmap,
            },
          ],
          this.proxyManager
        );
        this.labelmapProxy = this.proxyManager.getActiveSource();

        // set color of label 1
        const color = this.getNextColorArray();
        labelmap.setLabelColor(1, color);

        // activate master source b/c we can't window/level nor slice scroll
        // on the labelmap proxy due to lack of property domains.
        this.master.activate();
      } else {
        this.labelmapProxy = selected;
      }

      if (this.labelmapProxy) {
        const labelmap = this.labelmapProxy.getDataset();
        const updateFunc = () => {
          const cm = labelmap.getColorMap();
          const numComp = (a, b) => a - b;
          this.colormapArray = Object.keys(cm)
            .sort(numComp)
            .map((label) => ({
              label: Number(label), // object keys are always strings
              color: cm[label].slice(0, 3),
              opacity: cm[label][3],
            }));
        };
        this.labelmapSub.sub(labelmap.onModified(updateFunc));
        // initialize colormap
        updateFunc();
      }
    },
    setLabelColor(label, colorStr) {
      const lb = this.labelmapProxy.getDataset();
      const cm = lb.getColorMap();
      const origColor = cm[label];
      const colorArray = this.fromHex(colorStr);
      if (colorArray.length === 3) {
        lb.setLabelColor(label, [...colorArray, origColor[3]]);

        this.$forceUpdate();
        this.proxyManager.renderAllViews();
      }
    },
    setLabelOpacity(label, opacityInput) {
      const lb = this.labelmapProxy.getDataset();
      const cm = lb.getColorMap();
      const color = cm[label].slice();
      if (opacityInput) {
        // input is in [0, 255]
        color[3] = Number(opacityInput);
        lb.setLabelColor(label, color);
      }

      this.$forceUpdate();
      this.proxyManager.renderAllViews();
    },
    addLabel() {
      const labels = this.colormapArray.map((cm) => cm.label);
      // find next available label
      let newLabel = 0;
      while (labels.length) {
        const l = labels.shift();
        if (l - newLabel > 1) {
          newLabel++;
          break;
        }
        if (labels.length === 0) {
          newLabel = l + 1;
          break;
        }
        newLabel = l;
      }
      this.label = newLabel;

      const newColor = this.getNextColorArray();
      this.labelmapProxy.getDataset().setLabelColor(newLabel, newColor);

      this.$forceUpdate();
    },
    deleteLabel(label) {
      this.labelmapProxy.getDataset().removeLabel(label);

      // clear label from paintFilter's output image
      // this will update the internal painted image.
      const paintedImage = this.filter.getOutputData();
      const data = paintedImage
        .getPointData()
        .getScalars()
        .getData();
      for (let i = 0; i < data.length; i++) {
        if (data[i] === label) {
          data[i] = 0;
        }
      }

      // set this.label to a valid label (0 is always valid)
      this.label = 0;

      this.proxyManager.renderAllViews();
      this.$forceUpdate();
    },
    undo() {
      this.filter.undo();
      this.proxyManager.renderAllViews();
    },
    redo() {
      this.filter.redo();
      this.proxyManager.renderAllViews();
    },
    colorToBackgroundCSS(cmArray, index) {
      const { color, opacity } = cmArray[index];
      const rgba = [...color, opacity / 255];
      return {
        backgroundColor: `rgba(${rgba.join(',')})`,
      };
    },
    addWidgetToViews() {
      // helper method to update handle pos from slice
      const updateHandleFromSlice = (representation, view) => {
        const ijk = [0, 0, 0];
        const position = [0, 0, 0];
        ijk[view.getAxis()] = representation.getSlice();
        this.labelmapProxy
          .getDataset()
          .getImageRepresentation()
          .indexToWorldVec3(ijk, position);

        this.widget.getManipulator().setOrigin(position);
      };

      // helper method to update handle orientation
      const updateHandleOrientation = (view) => {
        if (view.isA('vtkView2DProxy')) {
          const normal = view.getCamera().getDirectionOfProjection();
          const handle = this.widget.getWidgetState().getHandle();
          const manipulator = this.widget.getManipulator();
          // since normal points away from camera, have handle normal point
          // towards camera so the paint widget can render the handle on top
          // of the image.
          handle.rotateFromDirections(
            handle.getDirection(),
            normal.map((n) => n * -1)
          );
          manipulator.setNormal(normal);
        }
      };

      // find 3d view; assume it always exists
      this.view3D = this.proxyManager.getViews().find(
        (v) => v.getClassName() === 'vtkViewProxy'
      );
      if (!this.view3D) {
        vtkErrorMacro('Could not find a 3D view!');
        return;
      }

      // add widget to views
      this.subs.push(
        forAllViews(this.proxyManager, (view) => {
          const widgetManager = view.getReferenceByName('widgetManager');
          if (view.isA('vtkView2DProxy')) {
            const viewWidget = widgetManager.addWidget(
              this.widget,
              ViewTypes.SLICE
            );

            widgetManager.grabFocus(this.widget);

            // tell labelmap slice who the master slice is
            const masterRep = this.proxyManager.getRepresentation(
              this.master,
              view
            );

            const rep = this.proxyManager.getRepresentation(
              this.labelmapProxy,
              view
            );
            rep.setMasterSlice(masterRep);

            // update handle position from slice position and handle orientation
            updateHandleFromSlice(rep, view);
            updateHandleOrientation(view);

            // link interactors
            this.subs.push(
              linkInteractors(view, this.view3D)
            );

            this.subs.push(
              rep.onModified(() => updateHandleFromSlice(rep, view))
            );

            viewWidget.onStartInteractionEvent(() => {
              this.filter.startStroke();
            });

            viewWidget.onInteractionEvent(() => {
              if (viewWidget.getPainting()) {
                this.filter.addPoint(
                  this.widget.getWidgetState().getTrueOrigin()
                );
              }
            });

            viewWidget.onEndInteractionEvent(() => {
              this.filter.addPoint(
                this.widget.getWidgetState().getTrueOrigin()
              );
              this.filter.endStroke();
            });
          } else {
            // all other views assumed to be 3D views
            widgetManager.disablePicking();
            widgetManager.addWidget(
              this.widget,
              ViewTypes.VOLUME
            );
          }
        })
      );

      // whenever active view changes, update handle orientation and position.
      this.subs.push(
        this.proxyManager.onActiveViewChange((view) => {
          if (view.isA('vtkView2DProxy')) {
            updateHandleOrientation(view);

            // Update handle based on master representation.
            // If we go based on labelmap representation,
            // we run the risk of creating the labelmap rep before the
            // master rep, which would result in the labelmap rep rendering
            // first, and thus rendering behind the master slice rep.
            const rep = this.proxyManager.getRepresentation(this.master, view);
            updateHandleFromSlice(rep, view);
          }
        })
      );

      // first handle orientation update
      updateHandleOrientation(this.proxyManager.getActiveView());
    },
    removeWidgetFromViews() {
      while (this.subs.length) {
        this.subs.pop().unsubscribe();
      }

      this.proxyManager.getViews().forEach((view) => {
        const widgetManager = view.getReferenceByName('widgetManager');
        if (widgetManager) {
          widgetManager.releaseFocus();
          widgetManager.removeWidget(this.widget);
        }
      });
    },
  },
};
