package com.boardroamer.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.os.Bundle;

/** The home screen widgets, one receiver per layout (see Widgets). They differ only in what they show and how. */
public final class WidgetProviders {
    private WidgetProviders() {}

    public abstract static class Base extends AppWidgetProvider {
        abstract Widgets.Kind kind();
        abstract Widgets.Layout layout();

        @Override public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
            for (int id : ids) Widgets.render(c, m, id, kind(), layout());
        }

        @Override public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle o) {
            Widgets.render(c, m, id, kind(), layout()); // resized: fit more or fewer items
        }

        @Override public void onDeleted(Context c, int[] ids) { Widgets.forget(c, ids); }
    }

    public static final class FollowStrip extends Base { Widgets.Kind kind() { return Widgets.Kind.FOLLOW; } Widgets.Layout layout() { return Widgets.Layout.STRIP; } }
    public static final class FollowList extends Base { Widgets.Kind kind() { return Widgets.Kind.FOLLOW; } Widgets.Layout layout() { return Widgets.Layout.LIST; } }
    public static final class FollowSummary extends Base { Widgets.Kind kind() { return Widgets.Kind.FOLLOW; } Widgets.Layout layout() { return Widgets.Layout.SUMMARY; } }
    public static final class LibraryGrid extends Base { Widgets.Kind kind() { return Widgets.Kind.LIBRARY; } Widgets.Layout layout() { return Widgets.Layout.GRID; } }
    public static final class LibraryList extends Base { Widgets.Kind kind() { return Widgets.Kind.LIBRARY; } Widgets.Layout layout() { return Widgets.Layout.LIST; } }
    public static final class LibraryFeature extends Base { Widgets.Kind kind() { return Widgets.Kind.LIBRARY; } Widgets.Layout layout() { return Widgets.Layout.FEATURE; } }
    public static final class LocalGrid extends Base { Widgets.Kind kind() { return Widgets.Kind.LOCAL; } Widgets.Layout layout() { return Widgets.Layout.GRID; } }
    public static final class LocalList extends Base { Widgets.Kind kind() { return Widgets.Kind.LOCAL; } Widgets.Layout layout() { return Widgets.Layout.LIST; } }
    public static final class LocalRow extends Base { Widgets.Kind kind() { return Widgets.Kind.LOCAL; } Widgets.Layout layout() { return Widgets.Layout.STRIP; } }
}
