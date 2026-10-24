package de.slizex.allhome;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AllHomePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
