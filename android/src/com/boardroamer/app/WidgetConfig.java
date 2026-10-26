package com.boardroamer.app;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

/** Shown when a widget is added (and, on Android 12+, from "Reconfigure"): its look, and when it may show pictures. */
public class WidgetConfig extends Activity {
    private int id = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        setResult(RESULT_CANCELED);
        id = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return; }

        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (20 * d);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(pad, pad * 2, pad, pad);

        col.addView(heading("Widget look", 0));
        RadioGroup style = group(new String[] { "Automatic (rounded on Samsung)", "Board Roamer (square, outlined)", "Rounded (matches One UI)" }, Widgets.style(this, id));
        col.addView(style);

        col.addView(heading("Pictures", (int) (18 * d)));
        RadioGroup pics = group(new String[] { "Hide pictures from adult sources", "Show all pictures", "Never show pictures" }, Widgets.pics(this, id));
        col.addView(pics);

        TextView note = new TextView(this);
        note.setText("Widgets sit on your home screen where others can see them. Pictures stay hidden while Blur thumbnails is on in Board Roamer.");
        note.setTextSize(12);
        note.setAlpha(0.7f);
        note.setPadding(0, (int) (14 * d), 0, (int) (20 * d));
        col.addView(note);

        Button ok = new Button(this);
        ok.setText("Done");
        ok.setOnClickListener(v -> {
            Widgets.configure(this, id, style.indexOfChild(style.findViewById(style.getCheckedRadioButtonId())), pics.indexOfChild(pics.findViewById(pics.getCheckedRadioButtonId())));
            Widgets.refreshOne(this, id);
            setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id));
            finish();
        });
        col.addView(ok, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ScrollView sv = new ScrollView(this);
        sv.addView(col);
        setContentView(sv);
    }

    private TextView heading(String text, int top) {
        TextView t = new TextView(this);
        t.setText(text.toUpperCase());
        t.setTextSize(12);
        t.setLetterSpacing(0.12f);
        t.setAlpha(0.7f);
        t.setGravity(Gravity.START);
        t.setPadding(0, top, 0, (int) (6 * getResources().getDisplayMetrics().density));
        return t;
    }

    private RadioGroup group(String[] labels, int checked) {
        RadioGroup g = new RadioGroup(this);
        for (int i = 0; i < labels.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setText(labels[i]);
            r.setId(View.generateViewId());
            r.setPadding(r.getPaddingLeft(), (int) (8 * getResources().getDisplayMetrics().density), 0, (int) (8 * getResources().getDisplayMetrics().density));
            g.addView(r);
            if (i == checked) g.check(r.getId());
        }
        return g;
    }
}
