import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/context/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import Index from "./pages/Index";
import Jugadores from "./pages/Jugadores";
import Analisis from "./pages/Analisis";
import Registros from "./pages/Registros";
import JugadorDetalle from "./pages/JugadorDetalle";
import AnalizadorSprint from "./pages/Cronometro";
import Usuarios from "./pages/Usuarios";
import Configuracion from "./pages/Configuracion";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<ProtectedRoute><Index /></ProtectedRoute>} />
            <Route path="/jugadores" element={<ProtectedRoute><Jugadores /></ProtectedRoute>} />
            <Route path="/jugadores/:id" element={<ProtectedRoute><JugadorDetalle /></ProtectedRoute>} />
            <Route path="/registros" element={<ProtectedRoute><Registros /></ProtectedRoute>} />
            <Route path="/analisis" element={<ProtectedRoute><Analisis /></ProtectedRoute>} />
            <Route path="/sprint" element={<ProtectedRoute><AnalizadorSprint /></ProtectedRoute>} />
            <Route path="/usuarios" element={<ProtectedRoute><Usuarios /></ProtectedRoute>} />
            <Route path="/configuracion" element={<ProtectedRoute><Configuracion /></ProtectedRoute>} />
            {/* Redirige rutas antiguas */}
            <Route path="/cronometro" element={<Navigate to="/sprint" replace />} />
            <Route path="/videos" element={<Navigate to="/sprint" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
