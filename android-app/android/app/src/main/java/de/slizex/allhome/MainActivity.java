package de.slizex.allhome;

import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AllHomePlugin.class);
        super.onCreate(savedInstanceState);
    }

    /* App-Symbol hell/dunkel: Launcher anstoßen, falls er noch das Symbol des anderen Modus zeigt */
    @Override
    public void onResume() {
        super.onResume();
        SymbolFarbe.pruefen(this);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        SymbolFarbe.pruefen(this);
    }
}
