import { useState, useCallback } from "react";
import { Upload, Video, Zap, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface VideoUploadProps {
  onUpload?: (file: File, type: "sprint" | "salto") => void;
}

const VideoUpload = ({ onUpload }: VideoUploadProps) => {
  const [dragOver, setDragOver] = useState(false);
  const [selectedType, setSelectedType] = useState<"sprint" | "salto">("sprint");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setSelectedFile(file);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setSelectedFile(file);
  };

  const handleProcess = () => {
    if (!selectedFile) return;
    setProcessing(true);
    onUpload?.(selectedFile, selectedType);
    setTimeout(() => {
      setProcessing(false);
      setSelectedFile(null);
    }, 3000);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6 card-elevated animate-slide-in">
      <h3 className="font-display font-bold text-lg text-foreground mb-4">Subir Video</h3>

      {/* Type selector */}
      <div className="flex gap-2 mb-5">
        {(["sprint", "salto"] as const).map((type) => (
          <button
            key={type}
            onClick={() => setSelectedType(type)}
            className={`flex-1 rounded-lg px-4 py-3 text-sm font-medium transition-all duration-200 border ${
              selectedType === type
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-surface text-muted-foreground hover:border-primary/30"
            }`}
          >
            {type === "sprint" ? "🏃 Sprint 40m" : "🦘 Salto"}
          </button>
        ))}
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative rounded-xl border-2 border-dashed p-8 text-center transition-all duration-300 ${
          dragOver
            ? "border-primary bg-primary/5"
            : selectedFile
            ? "border-primary/40 bg-primary/5"
            : "border-border hover:border-muted-foreground/40"
        }`}
      >
        {selectedFile ? (
          <div className="space-y-3">
            <Video className="h-10 w-10 text-primary mx-auto" />
            <div>
              <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
              <p className="text-xs text-muted-foreground">
                {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
            <button
              onClick={() => setSelectedFile(null)}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors"
            >
              <X className="h-4 w-4 inline mr-1" />
              Quitar
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <Upload className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm text-foreground font-medium">
                Arrastra un video aquí
              </p>
              <p className="text-xs text-muted-foreground mt-1">o haz clic para seleccionar</p>
            </div>
          </div>
        )}
        <input
          type="file"
          accept="video/*"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          onChange={handleFileSelect}
        />
      </div>

      {/* Process button */}
      <Button
        className="w-full mt-4 bg-primary text-primary-foreground font-display font-semibold hover:bg-primary/90 transition-all"
        disabled={!selectedFile || processing}
        onClick={handleProcess}
      >
        {processing ? (
          <>
            <Zap className="h-4 w-4 mr-2 animate-spin" />
            Procesando con IA...
          </>
        ) : (
          <>
            <Zap className="h-4 w-4 mr-2" />
            Analizar con IA
          </>
        )}
      </Button>
    </div>
  );
};

export default VideoUpload;
